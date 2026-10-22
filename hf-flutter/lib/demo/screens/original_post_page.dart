import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../data/telemetry.dart';
import '../theme.dart';

/// [HF-REEL-ORIGINAL-1] The reel's original post (Instagram / YouTube) inside the app, with an X to come straight back to
/// the video (owner 2026-10-22: viewers must not be sent to another app). This is the attribution link that replaced the
/// "Open in Instagram" chip on the video. The page stays on the platform's own website: links to other sites and
/// "open the app" links (intent:, instagram:, vnd.youtube:) are ignored.
class OriginalPostPage extends StatefulWidget {
  const OriginalPostPage({super.key, required this.url});

  final Uri url;

  /// Opens the page full screen over everything (the reel underneath pauses while it is open).
  static Future<void> open(BuildContext context, Uri url) {
    Telemetry.event('hf_reel_action', {'action': 'open_original'});
    return Navigator.of(context, rootNavigator: true).push<void>(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (_) => OriginalPostPage(url: url),
      ),
    );
  }

  /// True for the hosts the page may show: the platform the post lives on.
  @visibleForTesting
  static bool allowed(Uri u) {
    if (u.scheme != 'https') return false;
    final h = u.host.toLowerCase();
    bool on(String d) => h == d || h.endsWith('.$d');
    return on('instagram.com') ||
        on('youtube.com') ||
        on('youtu.be') ||
        on('facebook.com') || // Instagram's login hands off through these
        on('cdninstagram.com');
  }

  static String nameFor(Uri u) =>
      u.host.contains('instagram') ? 'Instagram' : 'YouTube';

  @override
  State<OriginalPostPage> createState() => _OriginalPostPageState();
}

class _OriginalPostPageState extends State<OriginalPostPage> {
  late final WebViewController _web = WebViewController()
    ..setJavaScriptMode(JavaScriptMode.unrestricted)
    ..setBackgroundColor(Colors.white)
    ..setNavigationDelegate(
      NavigationDelegate(
        onNavigationRequest: (r) {
          if (!r.isMainFrame) return NavigationDecision.navigate;
          final u = Uri.tryParse(r.url);
          return u != null && OriginalPostPage.allowed(u)
              ? NavigationDecision.navigate
              : NavigationDecision.prevent;
        },
        onProgress: (p) {
          if (mounted) setState(() => _progress = p);
        },
      ),
    )
    ..loadRequest(widget.url);

  int _progress = 0;

  @override
  Widget build(BuildContext context) {
    final name = OriginalPostPage.nameFor(widget.url);
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: C.cinema,
        foregroundColor: C.ivory,
        automaticallyImplyLeading: false,
        title: Text(name, style: t(17, color: C.ivory)),
        actions: [
          IconButton(
            key: const ValueKey('original-close'),
            tooltip: 'Close and go back to the video',
            iconSize: 28,
            onPressed: () => Navigator.of(context).maybePop(),
            icon: const Icon(Icons.close_rounded),
          ),
          const SizedBox(width: 4),
        ],
        bottom: _progress < 100
            ? PreferredSize(
                preferredSize: const Size.fromHeight(3),
                child: LinearProgressIndicator(
                  value: _progress / 100,
                  minHeight: 3,
                  color: C.marigold,
                  backgroundColor: Colors.transparent,
                ),
              )
            : null,
      ),
      body: WebViewWidget(controller: _web),
    );
  }
}
