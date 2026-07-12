import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../identity/identity.dart';
import '../sync/party/party_hub.dart';
import 'analytics.dart';
import 'ava_log.dart';
import 'config.dart';
import 'disk_cache.dart';
import 'feature_flags.dart';
import 'money_api.dart';
import 'net/ava_dns.dart';

/// Remote kill switches (creator-marketplace Phase 1, audit A2). Mirrors the
/// Worker's GET /api/config (KV `platform_config`). Fetched at app start and
/// every 15 min; money/live UI must check the matching getter before
/// rendering. Defaults are PERMISSIVE except real money, so a fetch failure
/// never bricks the app.
class RemoteConfig {
  RemoteConfig._();

  static Map<String, dynamic> _cfg = const {};
  static Timer? _timer;

  /// Bumps whenever a fetch lands — listen to re-check flags (e.g. the
  /// minAppBuild gate in RootFlow).
  static final ValueNotifier<int> revision = ValueNotifier(0);

  /// Whether the SIGNED-IN account is a platform admin (uid ∈ server ADMIN_UIDS).
  /// Resolved by [refreshAdmin] via the existing signed /admin/recon probe. Used
  /// to surface admin-only, not-yet-launched surfaces (e.g. the Marketplace) to
  /// the operator without exposing them to ordinary testers. Per-account: it is
  /// re-resolved on every config refresh AND on every account switch (see
  /// [onAccountSwitched]), so an account switch on a shared phone re-checks
  /// against the newly active token instead of inheriting the departing
  /// account's value.
  static bool _isAdmin = false;
  static bool get isAdmin => _isAdmin;

  /// Per-account cache key for [_isAdmin]. DiskCache is scoped by AccountScope.id,
  /// so each account on a shared phone keeps its OWN cached admin flag — a switch
  /// never inherits the previous account's value, and there is no cross-account
  /// leak. The signed /admin/recon probe ([refreshAdmin]) stays the source of
  /// truth and refreshes this cache; the cache only supplies an instant, leak-free
  /// paint before the probe lands (no Marketplace flicker on a non-admin child).
  static const String _kAdminCache = 'is_admin';

  /// Load the ACTIVE account's cached admin flag into memory (instant paint).
  /// Never throws; defaults to non-admin when nothing is cached for this account.
  static Future<void> _loadAdminCache() async {
    bool v = false;
    try { v = (await DiskCache.read(_kAdminCache)) == '1'; } catch (_) {/* best-effort */}
    if (v != _isAdmin) { _isAdmin = v; revision.value++; }
  }

  /// Re-resolve admin state for the NEWLY active account after an account switch.
  /// Step 1 paints the target account's own cached value instantly (leak-free on a
  /// shared phone — a non-admin child no longer briefly sees admin-only surfaces
  /// like the Marketplace). Step 2 re-probes the server to confirm + refresh the
  /// cache. Skips the network probe on logout (no active account). Never throws.
  static Future<void> onAccountSwitched() async {
    await _loadAdminCache();
    if (AccountScope.id != null && AccountScope.id!.isNotEmpty) {
      unawaited(refreshAdmin());
    }
  }

  static bool _b(String k, bool dflt) => _cfg[k] is bool ? _cfg[k] as bool : dflt;

  /// Tolerant numeric parsing: handles bool→num cast (when server sends true/false
  /// for numeric fields). Converts bool 1→1, 0→0; otherwise tries num parse.
  /// This prevents "bool is not num?" crashes when config fields are mistyped.
  static num? _asNum(dynamic v) => v is num ? v : (v is bool ? (v ? 1 : 0) : null);

  // FREE LAUNCH (2026-06-28, Specs/FREE-LAUNCH-DIRECTION.md): the hidden-feature
  // defaults below flip to FALSE so a config-fetch failure renders the focused
  // free product (not the full marketplace). The live KV `platform_config`
  // mirrors these; flip them back when paid/marketplace returns.
  static bool get walletRealMoney => _b('walletRealMoney', false);
  static bool get donationsEnabled => _b('donationsEnabled', true);
  static bool get liveEnabled => _b('liveEnabled', false);
  static bool get consultEnabled => _b('consultEnabled', false);
  static bool get conferenceEnabled => _b('conferenceEnabled', true);
  /// CF Realtime SFU group-audio path — dormant until its build lands + is
  /// CI/device-verified. While false, group calls use the existing LiveKit path.
  static bool get groupAudioSfuEnabled => _b('groupAudioSfuEnabled', false);
  static bool get brainEnabled => _b('brainEnabled', false);
  static bool get verseEnabled => _b('verseEnabled', false);
  static bool get translationEnabled => _b('translationEnabled', false);
  static bool get translationGroupEnabled => _b('translationGroupEnabled', false);
  static bool get avavoiceEnabled => _b('avavoiceEnabled', false);
  static bool get avavisionEnabled => _b('avavisionEnabled', false);
  // STREAM G (AI in chats). Mirrors config.ts flags of the same name.
  /// [GROUP-AI-2] per-member group translation (translate on fetch). Default OFF
  /// (cost watch) — the "Translate this group for me" toggle is hidden while off.
  static bool get groupTranslationEnabled => _b('groupTranslationEnabled', false);
  /// [GROUP-AI-4] DM smart-reply suggestion chips. Default ON.
  static bool get smartRepliesEnabled => _b('smartRepliesEnabled', true);
  /// [GROUP-AI-6] auto scam-scan a stranger thread on first render. Default ON.
  static bool get scamAutoScanEnabled => _b('scamAutoScanEnabled', true);
  /// STREAM I (AI Messenger Batch): unlimited forwarding + forward-to-groups.
  /// Master kill switch for the whole forwarding feature — the multi-select
  /// forward sheet and the /api/msg/forward route both gate on this. Default ON
  /// (per spec FWD-4); flip OFF in KV to fall back to hiding Forward if abuse
  /// ever spikes. Mirrors config.ts `unlimitedForwardEnabled`.
  static bool get unlimitedForwardEnabled => _b('unlimitedForwardEnabled', true);
  /// FREE LAUNCH: no paywalls. When true, the whole client renders premium and
  /// no upgrade/metering UI shows. Mirrors KV `betaFreePremium`.
  static bool get betaFreePremium => _b('betaFreePremium', true);
  /// FREE LAUNCH: subscriptions/checkout off. When false, hide Subscribe/upgrade
  /// + wallet top-up entry points. Mirrors KV `billingEnabled`.
  static bool get billingEnabled => _b('billingEnabled', false);
  /// AI receptionist (Gemini Live) — ON for the free launch. Mirrors KV.
  static bool get receptionistEnabled => _b('receptionistEnabled', true);
  /// [BUSY-CARD-1] Personalized busy card (Cancel / Notify me / Leave a message
  /// for Ava) shown when a call resolves to 'busy'. Client kill switch mirroring
  /// the server's busy-card flag. The card ALSO requires the server to send a
  /// `busy_reason` on the busy status — so even with this ON, an old server that
  /// sends no reason falls back to the plain "User is busy" line. Default ON;
  /// flip to false in KV to force legacy behaviour everywhere. Mirrors config.ts.
  static bool get busyCardEnabled => _b('busyCardEnabled', true);
  /// CALL OUTCOME MENU (Specs/CALL-OUTCOME-MENU-SPEC-2026-07-09.md): one unified
  /// caller-facing menu for every non-answered call (declined / no-answer /
  /// unreachable / busy). Talk to Ava, voice note, text note, See Listings.
  /// Ships DARK (default false); flip callMenuEnabled=true in KV to activate.
  /// Mirrors config.ts.
  static bool get callMenuEnabled => _b('callMenuEnabled', false);
  /// "See Listings" button on the call outcome menu — OFF until the marketplace
  /// goes public (owner 2026-07-09). Mirrors config.ts.
  static bool get callMenuListingsEnabled => _b('callMenuListingsEnabled', false);
  /// MKT-LANG (AI Messenger Batch, STREAM A): the "Marketplace Agent" settings
  /// surface (default language/voice/tone + negotiation guardrails). Default ON;
  /// the settings tile hides when false. Mirrors config.ts.
  static bool get marketplaceAgentSettingsEnabled => _b('marketplaceAgentSettingsEnabled', true);
  /// MKT-LANG-3: English-canonical negotiation + per-recipient translation +
  /// quiet-hours/floor/ask-before-commit guardrails. Default ON. Mirrors config.ts.
  static bool get mktI18nNegotiationEnabled => _b('mktI18nNegotiationEnabled', true);
  /// P1 call-reliability: gate the caller's Ava-takeover countdown on the server's
  /// ring-ack (incoming-call FCM push outcome). Ships dark (default OFF); flip in
  /// KV after a device test. Mirrors config.ts `receptTakeoverGuard`.
  static bool get receptTakeoverGuard => _b('receptTakeoverGuard', false);
  /// P4: require video-liveness verification before creating/publishing a listing.
  /// Ships dark (default OFF); flip ON at launch. Mirrors config.ts.
  static bool get listingLivenessGate => _b('listingLivenessGate', false);
  /// Liveness V2 (Specs/LIVENESS-V2-PLAN.md): the ML-Kit-gated, detection-driven
  /// selfie-video flow that replaces the timer-script V1. Ships DARK (default
  /// OFF); while off the V1 [LivenessCheckScreen] is used unchanged. Flip
  /// `livenessV2Enabled: true` in KV `platform_config` once V2 pass-rate is
  /// proven. Mirrors config.ts.
  static bool get livenessV2Enabled => _b('livenessV2Enabled', false);
  /// Liveness V3 (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-DRAFT.md): the voice-guided
  /// flow — language picker, on-device ML Kit coaching with pre-recorded Ava voice
  /// packs, server-randomized challenges, per-stage no-dead-screen watchdog, and
  /// background upload to presigned R2. Ships DARK (default OFF); while off the V2
  /// [LivenessV2Screen] (or V1) is used unchanged. Flip `livenessV3Enabled: true`
  /// in KV `platform_config` once V3 pass-rate is proven. Mirrors config.ts. Takes
  /// precedence over V2 when both are on.
  static bool get livenessV3Enabled => _b('livenessV3Enabled', false);
  /// [LIVE-DIDIT-1] didit.me-hosted liveness (owner decision 2026-07-09) — THE
  /// live path; takes precedence over v3/v2/v1. Default TRUE (this is the
  /// pipeline now); the flag exists only as a kill switch. Mirrors config.ts.
  static bool get diditLivenessEnabled => _b('diditLivenessEnabled', true);
  // [AVA-IDGATE-1] livenessOnboardingGate getter REMOVED. The onboarding/app-open
  // liveness gate (HumanCheckPage + _landOrGate) is gone; liveness fires at the first
  // public action, enforced server-side. Nothing on the client reads this any more.
  /// P11: mandatory + AI-vetted profile completion. Ships dark (default OFF); flip
  /// ON at launch. When on, an incomplete profile is routed to the Profile screen
  /// before the app, and the save shows a hold state while the server vets. Mirrors config.ts.
  static bool get profileCompletionGate => _b('profileCompletionGate', false);
  /// P8 Stage 3: daily auto-backup to the user's OWN Google Drive — ON for ALL
  /// users (no premium gate). Flip OFF in KV to disable the daily job.
  static bool get driveAutoBackup => _b('driveAutoBackup', true);
  /// P8 Stage 2: lazily page older history from R2 beyond the hot window. Dark.
  static bool get restoreV2 => _b('restoreV2', false);
  /// ChatAVA "talk to Ava by voice" — the hands-free Gemini Live call
  /// (LiveVoiceController). Owner kill switch (2026-06-27): default OFF so the
  /// feature stays dark after a config-fetch failure and can't burn the shared
  /// Gemini Live quota. NOTE: distinct from [avavoiceEnabled] (the AvaVoice
  /// studio/agents app). Flip `aiVoiceCallEnabled: true` in KV `platform_config`
  /// to re-enable. Premium still applies on top of this when the switch is on.
  static bool get aiVoiceCallEnabled => _b('aiVoiceCallEnabled', false);
  /// AvaAffiliate (PROPOSAL-AVA-AFFILIATE) — default OFF until launch, so a
  /// config-fetch failure never advertises a program the Worker isn't serving.
  static bool get avaAffiliateEnabled => _b('avaAffiliateEnabled', false);
  /// v2 marketing-asset kit (Gemini Nano Banana 2 promo images) — default OFF.
  static bool get affiliateAssetKitEnabled => _b('affiliateAssetKitEnabled', false);
  /// AI Ringback Tones + Busy Tone — master switch (server panic off). Default
  /// mirrors kRingbackEnabledDefault so a fetch failure keeps the feature on.
  static bool get ringbackEnabled => _b('ringbackEnabled', kRingbackEnabledDefault);
  /// In-chat AI image generation (ChatAVA "make an image"). Server kill switch
  /// mirrors the compile default [kGenerativeEnabledDefault]. When false the
  /// client short-circuits every image request to a canned "coming soon" reply
  /// WITHOUT a network call (see ava_generative/image_tool.dart). Live (pro)
  /// build sets `imageGenEnabled:false` in prod KV; staging keeps it true so the
  /// side-by-side test APK still exercises generation.
  static bool get imageGenEnabled => _b('imageGenEnabled', kGenerativeEnabledDefault);
  /// Guardian (scam/grooming/deepfake safety) surfaces + settings section.
  /// Mirrors the compile default [kGuardianEnabledDefault]. When false the
  /// Guardian settings section is not registered and the per-chat shield icon is
  /// hidden. Live (pro) build sets `guardianEnabled:false` in prod KV.
  static bool get guardianEnabled => _b('guardianEnabled', kGuardianEnabledDefault);
  /// U1-lite (Guardian Sentinel §U1): MANUAL "Require verification" gate. When ON,
  /// the guardian settings sheet shows a "Require verification" row for 1:1 chats
  /// that asks the peer to complete a live face check (Trust Engine liveness).
  /// Fully DARK by default (server modes 403 `feature_off`; the client row is
  /// hidden). Mirrors config.ts `guardianGateEnabled`. Flip ON in KV platform_config.
  static bool get guardianGateEnabled => _b('guardianGateEnabled', false);
  /// AvaMarketplace (buy/sell/social + agent negotiation, Specs/AVAMARKETPLACE-
  /// FINAL-PROPOSAL.md). Default OFF so the feature stays dark after a config
  /// fetch failure and during phased rollout — flip `marketplaceEnabled: true`
  /// in KV `platform_config` to surface the Marketplace menu + agent calls.
  static bool get marketplaceEnabled => _b('marketplaceEnabled', false);

  /// Effective Marketplace visibility for the CURRENT account. The global
  /// `marketplaceEnabled` KV flag stays false during the phased/pro launch, so
  /// ordinary testers never see the Marketplace. Admins (see [isAdmin]) get it
  /// regardless, so the operator can dogfood + fix it in production while it
  /// stays hidden for everyone else. Toggle it per-tester by adding/removing
  /// their uid from the server ADMIN_UIDS var; flip `marketplaceEnabled: true`
  /// in KV `platform_config` for the eventual full launch to all users.
  static bool get marketplaceVisible => marketplaceEnabled || _isAdmin;
  /// DNS-over-HTTPS fallback (PERF-DNS-2): resolve our hostnames via 1.1.1.1 when
  /// the device resolver fails. Default ON (works before the first config fetch);
  /// this is a kill switch — set `dohFallbackEnabled: false` in KV to force pure
  /// OS resolution if the fallback ever misbehaves. Applied to [AvaDns] in refresh().
  static bool get dohFallbackEnabled => _b('dohFallbackEnabled', true);
  /// Link previews + inline YouTube (AI Messenger Batch — STREAM C). Mirrors the
  /// KV `linkPreviewsEnabled` flag. Default ON. When false the chat renders raw
  /// link text only and never calls /api/unfurl. Mirrors [kLinkPreviewsEnabledDefault].
  static bool get linkPreviewsEnabled => _b('linkPreviewsEnabled', kLinkPreviewsEnabledDefault);
  /// WhatsApp-parity rich input bar + emoji/GIF/sticker panel (AI Messenger
  /// Batch — STREAM E). Mirrors the KV `richInputEnabled` flag. Default ON. When
  /// false the chat falls back to the legacy composer row (no emoji/GIF/sticker
  /// panel, no GIF/sticker send). Add `richInputEnabled: true` to the config.ts
  /// PlatformConfig interface + defaults so it can be flipped from KV.
  static bool get richInputEnabled => _b('richInputEnabled', true);
  /// STREAM B (stranger safety gate). When false the whole feature is hidden: a
  /// new non-contact thread renders the normal composer (no gate), no Message
  /// requests grouping, no media blur. Default ON (safety ships enabled). Mirrors
  /// config.ts `strangerGateEnabled`.
  static bool get strangerGateEnabled => _b('strangerGateEnabled', true);
  // DIALPAD BUSINESS CALLS + AVA VOICE AGENT (Specs/PLAN-2026-07-11-dialpad-
  // business-calls-ava-voice-agent.md §8/§15.6). One kill switch per phase;
  // all default OFF so a config-fetch failure keeps today's behaviour exactly
  // as-is. Staging first; prod flipped one at a time on the owner's say-so.
  /// Phase A — the friend/business channel split: email-only new-chat search,
  /// tappable AvaTOK numbers → dialpad, the no-answer card, and the named
  /// incoming-business-call screen. Mirrors config.ts `businessCallUx`.
  static bool get businessCallUx => _b('businessCallUx', false);
  /// Phase B — the server-side voicemail bot (5-rings → prompt → 25s record).
  /// Mirrors config.ts `voicemailBot`.
  static bool get voicemailBot => _b('voicemailBot', false);
  /// Phase B2 — caller-pays paid calls (escrow + per-minute settle). Mirrors
  /// config.ts `paidCalls`.
  static bool get paidCalls => _b('paidCalls', false);
  /// Phase C — the Ava AI Voice Agent (Grok realtime session). Gates the
  /// "Send to Ava AI Agent" option on the incoming-business-call screen.
  /// Mirrors config.ts `voiceAgent`.
  static bool get voiceAgent => _b('voiceAgent', false);
  /// Phase C — additional caller-pays AvaTOK service numbers (Mode B only).
  /// Mirrors config.ts `serviceNumbers`.
  static bool get serviceNumbers => _b('serviceNumbers', false);
  /// Home · AvaDial · AvaTalk · Services 4-root shell (Specs/PLAN-2026-07-12-home-
  /// ava-tok-services-shell.md, Phase 1). Ships DARK (default false): while off the
  /// app renders today's messenger-first [AvaShell] byte-for-byte. Flip
  /// `shellV2: true` in KV `platform_config` (staging first) to switch to
  /// [ShellV2]. Mirrors config.ts `shellV2`.
  static bool get shellV2 => _b('shellV2', false);

  static int get minAppBuild => (_asNum(_cfg['minAppBuild'])?.toInt()) ?? 0;

  /// Installed build too old? → callers show the blocking "please update" screen.
  static bool get updateRequired => minAppBuild > kAppBuild;

  /// Kill switch for the Google Play in-app update flow (the "Update" sidebar row
  /// + the on-launch "new version available" popup). Default ON; flip to false in
  /// KV to silence all Play update checks (e.g. if they ever get noisy).
  static bool get inAppUpdateEnabled => _b('inAppUpdateEnabled', true);

  /// Fetch now + poll every 15 min. Never throws.
  static Future<void> start() async {
    // Paint the active account's cached admin flag first so admin-only surfaces
    // (Marketplace) render correctly on cold boot before the network probe lands.
    await _loadAdminCache();
    await refresh();
    // Resolve admin status alongside config so admin-only surfaces (Marketplace)
    // appear on this launch. Fire-and-forget: never blocks app start.
    unawaited(refreshAdmin());
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(minutes: 15), (_) {
      refresh();
      refreshAdmin();
    });
  }

  /// Probe whether the active account is an admin (signed /admin/recon → 200).
  /// Bumps [revision] on change so drawers/menus re-evaluate [marketplaceVisible].
  /// Never throws. Call again after an account switch to re-resolve.
  static Future<void> refreshAdmin() async {
    final scope = AccountScope.id; // capture: an account switch may race this probe
    try {
      final was = _isAdmin;
      final v = await MoneyApi.isAdmin();
      // If the active account changed while the probe was in flight, a newer
      // switch owns the admin state now — discard this (stale) result so we never
      // write one account's admin flag into another's scoped cache.
      if (AccountScope.id != scope) return;
      _isAdmin = v;
      if (_isAdmin != was) revision.value++;
      // Persist per-account so the next switch to this account paints instantly.
      try { await DiskCache.write(_kAdminCache, v ? '1' : '0'); } catch (_) {/* best-effort */}
      Analytics.capture('admin_probe', {'is_admin': v, 'account': scope ?? ''});
    } catch (e) {
      AvaLog.I.log('config', 'admin probe failed: $e');
    }
  }

  static Future<void> refresh() async {
    try {
      final res = await http
          .get(Uri.parse(kConfigUrl))
          .timeout(const Duration(seconds: 6));
      if (res.statusCode == 200) {
        final m = jsonDecode(res.body);
        if (m is Map<String, dynamic>) {
          _cfg = m;
          // PERF-DNS-2 kill switch: let KV disable the DoH fallback if needed.
          AvaDns.dohEnabled = dohFallbackEnabled;
          // PartyKit realtime layer master switch (replaces Ably). Ships dark
          // until the PartyDO is deployed + this flag flipped on server-side.
          PartyHub.I.setEnabled(m['partyEnabled'] == true);
          revision.value++;
        }
      }
    } catch (e) {
      AvaLog.I.log('config', 'remote config fetch failed: $e');
    }
  }
}
