// [LIVE-DIDIT-1] Liveness powered by didit.me (owner decision 2026-07-09).
// REPLACES the home-grown V2/V3 capture pipelines as the live path. Didit's
// hosted flow does all the camera/liveness work in the browser (Chrome Custom
// Tab); this screen keeps the SAME LiveTheme look for intro → waiting →
// passed/failed, so the app experience is visually unchanged.
//
// Flow:
//   1. POST /api/liveness/didit/session (Worker holds the API key; the client
//      never sees it) → {url, attempts_remaining}.
//   2. Open the URL in the system browser (url_launcher external mode — same
//      pattern as Clerk OAuth; embedded webviews are unreliable for camera).
//   3. Poll GET /api/liveness/didit/result every 3s. The Worker maps Didit's
//      decision to PASS/FAIL, applies the ladder on PASS, and enforces the
//      5-failed-tries-per-month policy.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
// [LIVE-DIDIT-2] (owner decision 2026-07-10) The Didit flow renders in an
// IN-APP WebView styled with LiveTheme — the user never leaves the app and no
// third-party branding chrome (browser bar, external tab) is visible. This is
// Didit's documented Flutter WebView integration (docs.didit.me → web-sdks →
// webview-in-ios-android): JS + DOM storage on, camera permission auto-granted,
// inline media playback, callback URL intercepted to detect completion.
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/profile_store.dart';
import 'liveness_v2/live_theme.dart';

class DiditLivenessScreen extends StatefulWidget {
  const DiditLivenessScreen({super.key, this.listingContext = false, this.requester = 'onboarding'});
  final bool listingContext;
  final String requester;

  @override
  State<DiditLivenessScreen> createState() => _DiditLivenessScreenState();
}

enum _Phase { intro, starting, webview, waiting, passed, failed, unavailable }

class _DiditLivenessScreenState extends State<DiditLivenessScreen> {
  _Phase _phase = _Phase.intro;
  String? _error;
  int? _attemptsRemaining;
  Timer? _poll;
  int _pollCount = 0;

  static const _maxPolls = 200; // ~10 min at 3s — Didit sessions live far longer

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    setState(() { _phase = _Phase.starting; _error = null; });
    Analytics.capture('liveness_started', {'provider': 'didit', 'source': widget.requester});
    // [LIVE-DIDIT-3] Claim-before-create: if a recent session already passed
    // (e.g. the phone lost the result last time — the 2026-07-10 stuck
    // "Checking…" bug), the server finds it by account and we're done without
    // making the user redo the check.
    try {
      final pre = await ApiAuth.getSigned('https://$kSignalingHost/api/liveness/didit/result')
          .timeout(const Duration(seconds: 10));
      if (pre.statusCode == 200) {
        final j = jsonDecode(pre.body) as Map<String, dynamic>;
        if ((j['verdict'] ?? '') == 'PASS') {
          Analytics.capture('liveness_passed', {'provider': 'didit', 'source': widget.requester, 'resumed': true});
          if (mounted) setState(() => _phase = _Phase.passed);
          return;
        }
      }
    } catch (_) {/* no prior pass — continue into a fresh session */}
    try {
      // [LIVE-DIDIT-5] Attach the user's details (as of NOW) so the Didit
      // dashboard is searchable by name/email and our server record captures
      // who they were at check time. Liveness runs at the END of onboarding,
      // so the profile is already filled in when we get here.
      Map<String, Object> details = const {};
      try {
        final p = await ProfileStore().load();
        final parts = p.displayName.trim().split(RegExp(r'\s+'));
        details = {
          if (p.displayName.trim().isNotEmpty) 'name': p.displayName.trim(),
          if (parts.isNotEmpty && parts.first.isNotEmpty) 'first_name': parts.first,
          if (parts.length > 1) 'last_name': parts.sublist(1).join(' '),
          if (p.email.trim().isNotEmpty) 'email': p.email.trim(),
          if (p.phone.trim().isNotEmpty) 'phone': p.phone.trim(),
        };
      } catch (_) {/* details are best-effort */}
      final res = await ApiAuth.postJson(
        'https://$kSignalingHost/api/liveness/didit/session', details,
        timeout: const Duration(seconds: 20),
      );
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 429 && j['reason'] == 'monthly_limit') {
        setState(() {
          _phase = _Phase.failed;
          _attemptsRemaining = 0;
          _error = (j['error'] ?? 'No tries left this month.').toString();
        });
        return;
      }
      // [LIVE-DIDIT-4] Launch-spike backoff: the server throttles session
      // creation to protect the Didit quota. Auto-retry after the advertised
      // wait — the user just sees "getting ready…", no error, no dead end.
      if (res.statusCode == 429) {
        final waitS = ((j['retry_after_s'] as num?)?.toInt() ?? 20).clamp(5, 120);
        Analytics.capture('liveness_didit_busy_retry', {'wait_s': waitS});
        if (!mounted) return;
        setState(() { _phase = _Phase.starting; _error = null; });
        Future.delayed(Duration(seconds: waitS), () { if (mounted && _phase == _Phase.starting) _start(); });
        return;
      }
      if (res.statusCode != 200 || (j['url'] ?? '').toString().isEmpty) {
        Analytics.error(
          domain: 'liveness', code: 'didit_session_failed',
          message: 'status ${res.statusCode} reason ${j['reason'] ?? 'unknown'}',
          screen: 'liveness_didit', action: 'session',
        );
        setState(() { _phase = _Phase.unavailable; _error = 'Could not start the check. Please try again.'; });
        return;
      }
      _attemptsRemaining = (j['attempts_remaining'] as num?)?.toInt();
      // [LIVE-DIDIT-2] Render Didit INSIDE the app. Poll runs alongside the
      // webview so a mid-flow decision is caught even if the callback is missed.
      _buildWebView(j['url'].toString());
      setState(() => _phase = _Phase.webview);
      _pollCount = 0;
      _poll?.cancel();
      _poll = Timer.periodic(const Duration(seconds: 3), (_) => _checkResult());
    } catch (e) {
      Analytics.error(
        domain: 'liveness', code: 'didit_session_failed', message: e.toString(),
        screen: 'liveness_didit', action: 'session',
      );
      if (mounted) setState(() { _phase = _Phase.unavailable; _error = 'Network problem — please try again.'; });
    }
  }

  // ── [LIVE-DIDIT-2] In-app WebView hosting the Didit flow ────────────────────
  WebViewController? _web;

  void _buildWebView(String sessionUrl) {
    late final PlatformWebViewControllerCreationParams params;
    if (WebViewPlatform.instance is WebKitWebViewPlatform) {
      params = WebKitWebViewControllerCreationParams(
        allowsInlineMediaPlayback: true,
        mediaTypesRequiringUserAction: const {},
      );
    } else {
      params = const PlatformWebViewControllerCreationParams();
    }
    final controller = WebViewController.fromPlatformCreationParams(params)
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(LiveTheme.stage)
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) {
            // Completion callback → stop the webview and let the result poll
            // (authoritative: our Worker reads Didit's decision) take over.
            if (request.url.contains('/api/liveness/didit/done')) {
              if (mounted) setState(() => _phase = _Phase.waiting);
              _checkResult();
              return NavigationDecision.prevent;
            }
            return NavigationDecision.navigate;
          },
        ),
      )
      ..loadRequest(Uri.parse(sessionUrl));
    // Auto-grant the camera/mic permission prompts INSIDE the webview (the app
    // already holds the OS-level camera permission from the old liveness flow).
    controller.platform.setOnPlatformPermissionRequest((request) => request.grant());
    if (controller.platform is AndroidWebViewController) {
      (controller.platform as AndroidWebViewController)
          .setMediaPlaybackRequiresUserGesture(false);
    }
    _web = controller;
  }

  int _pollErrors = 0;

  Future<void> _checkResult() async {
    if (!mounted || (_phase != _Phase.waiting && _phase != _Phase.webview)) return;
    if (++_pollCount > _maxPolls) { _poll?.cancel(); return; }
    try {
      final res = await ApiAuth.getSigned('https://$kSignalingHost/api/liveness/didit/result');
      if (res.statusCode != 200) {
        // [LIVE-DIDIT-3] Silent-forever polling is how the 2026-07-10 stuck
        // screen went undiagnosed — surface persistent poll failures.
        if (++_pollErrors == 5) {
          Analytics.error(
            domain: 'liveness', code: 'didit_poll_failing',
            message: 'status ${res.statusCode} x$_pollErrors',
            screen: 'liveness_didit', action: 'result',
          );
        }
        return; // keep polling
      }
      _pollErrors = 0;
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final verdict = (j['verdict'] ?? '').toString();
      if (verdict == 'PASS') {
        _poll?.cancel();
        Analytics.capture('liveness_passed', {'provider': 'didit', 'source': widget.requester});
        if (mounted) setState(() => _phase = _Phase.passed);
      } else if (verdict == 'FAIL') {
        _poll?.cancel();
        _attemptsRemaining = (j['attempts_remaining'] as num?)?.toInt();
        Analytics.capture('liveness_failed', {
          'provider': 'didit', 'source': widget.requester,
          'didit_status': (j['didit_status'] ?? '').toString(),
        });
        if (mounted) setState(() => _phase = _Phase.failed);
      }
      // pending → keep polling
    } catch (_) {/* transient — keep polling */}
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: LiveTheme.stage,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(22, 10, 22, 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Expanded(
                    child: Text('LIVENESS CHECK',
                        style: TextStyle(color: LiveTheme.subPaper, fontSize: 13,
                            fontWeight: FontWeight.w800, letterSpacing: 2.2)),
                  ),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(false),
                    icon: const Icon(Icons.close_rounded, color: LiveTheme.subPaper),
                  ),
                ],
              ),
              Expanded(child: _body()),
            ],
          ),
        ),
      ),
    );
  }

  Widget _body() {
    switch (_phase) {
      case _Phase.intro:
      case _Phase.starting:
        return _intro();
      case _Phase.webview:
        return _webviewStage();
      case _Phase.waiting:
        return _waiting();
      case _Phase.passed:
        return _resultView(
          icon: Icons.verified_rounded, color: LiveTheme.lime,
          lead: "You're ", mark: 'verified!',
          sub: 'All set — you can carry on in the app.',
          button: LiveTheme.limeButton(
            label: widget.listingContext ? 'Create a listing' : 'Done',
            icon: Icons.arrow_forward_rounded,
            onPressed: () => Navigator.of(context).pop(true),
          ),
        );
      case _Phase.failed:
        final none = (_attemptsRemaining ?? 1) <= 0;
        return _resultView(
          icon: Icons.replay_rounded, color: LiveTheme.coral,
          lead: none ? 'Out of ' : "That didn't ",
          mark: none ? 'tries' : 'work',
          sub: _error ??
              (none
                  ? "You've used all 5 tries for this month. Please try again next month."
                  : 'No worries — just try another take.'
                      '${_attemptsRemaining != null ? ' You have $_attemptsRemaining tries left this month.' : ''}'),
          button: none
              ? LiveTheme.limeButton(
                  label: 'Close', icon: Icons.close_rounded,
                  onPressed: () => Navigator.of(context).pop(false))
              : LiveTheme.limeButton(
                  label: 'Try again', icon: Icons.videocam_rounded, onPressed: _start),
        );
      case _Phase.unavailable:
        return _resultView(
          icon: Icons.cloud_off_rounded, color: LiveTheme.lilac,
          lead: 'Hit a ', mark: 'snag',
          sub: _error ?? 'Please try again in a moment.',
          button: LiveTheme.limeButton(
              label: 'Try again', icon: Icons.refresh_rounded, onPressed: _start),
        );
    }
  }

  Widget _intro() {
    final busy = _phase == _Phase.starting;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Spacer(),
        Center(
          child: Container(
            width: 104, height: 104,
            decoration: BoxDecoration(
              shape: BoxShape.circle, color: LiveTheme.lilac,
              border: Border.all(color: LiveTheme.ink, width: 3),
              boxShadow: const [BoxShadow(color: LiveTheme.ink, offset: Offset(6, 7))],
            ),
            child: const Icon(Icons.videocam_rounded, size: 46, color: LiveTheme.ink),
          ),
        ),
        const SizedBox(height: 22),
        LiveTheme.stageHeadline('Prove you are ', markWord: 'real'),
        const SizedBox(height: 12),
        Text(
          'A quick face check — look at the camera for a few seconds and '
          "you're done. Nothing to line up, nothing to read. "
          'Your check is deleted if it fails.',
          style: LiveTheme.subStyle,
        ),
        if (_error != null) ...[
          const SizedBox(height: 14),
          Text(_error!, style: LiveTheme.subStyle),
        ],
        const Spacer(),
        LiveTheme.limeButton(
          label: busy ? 'Starting…' : 'Start',
          icon: Icons.videocam_rounded,
          onPressed: busy ? null : _start,
        ),
      ],
    );
  }

  /// The Didit capture flow inside the SAME dark stage card the old liveness
  /// used — rounded, ink-bordered, LiveTheme all around. No browser chrome.
  Widget _webviewStage() {
    final web = _web;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: LiveTheme.cameraCard,
              borderRadius: BorderRadius.circular(22),
              border: Border.all(color: LiveTheme.ink, width: 2.5),
            ),
            child: web == null
                ? const Center(
                    child: CircularProgressIndicator(color: LiveTheme.lime))
                : WebViewWidget(controller: web),
          ),
        ),
        const SizedBox(height: 14),
        LiveTheme.stageHeadline('Quick face ', markWord: 'check'),
        const SizedBox(height: 6),
        Text('Look at the camera and follow along — takes a few seconds.',
            style: LiveTheme.subStyle),
      ],
    );
  }

  Widget _waiting() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Spacer(),
        const Center(
          child: SizedBox(
            width: 72, height: 72,
            child: CircularProgressIndicator(color: LiveTheme.lime, strokeWidth: 5),
          ),
        ),
        const SizedBox(height: 26),
        LiveTheme.stageHeadline('Checking', markWord: '…'),
        const SizedBox(height: 12),
        Text(
          'One moment — verifying your clip.',
          style: LiveTheme.subStyle,
        ),
        const Spacer(),
        TextButton(
          onPressed: () { _poll?.cancel(); _web = null; setState(() => _phase = _Phase.intro); },
          child: const Text('Start over', style: TextStyle(color: LiveTheme.subPaper)),
        ),
      ],
    );
  }

  Widget _resultView({
    required IconData icon, required Color color,
    required String lead, required String mark, required String sub,
    required Widget button,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Spacer(),
        Center(
          child: Container(
            width: 104, height: 104,
            decoration: BoxDecoration(
              shape: BoxShape.circle, color: color,
              border: Border.all(color: LiveTheme.ink, width: 3),
              boxShadow: const [BoxShadow(color: LiveTheme.ink, offset: Offset(6, 7))],
            ),
            child: Icon(icon, size: 48, color: LiveTheme.ink),
          ),
        ),
        const SizedBox(height: 22),
        LiveTheme.stageHeadline(lead, markWord: mark),
        const SizedBox(height: 12),
        Text(sub, style: LiveTheme.subStyle),
        const Spacer(),
        button,
      ],
    );
  }
}
