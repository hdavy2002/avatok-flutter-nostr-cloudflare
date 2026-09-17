import 'dart:convert';
import 'package:webview_flutter/webview_flutter.dart';
import 'ui_locale_controller.dart';

Future<void> applyUiLocaleToWebView(WebViewController web, String url) async {
  final uri = Uri.tryParse(url);
  if (uri == null || uri.scheme != 'https' ||
      !(uri.host == 'avatok.ai' || uri.host.endsWith('.avatok.ai'))) return;
  final code = jsonEncode(UiLocaleController.instance.selected.code);
  try {
    await web.runJavaScript('''
      window.__avatokUiLocale = $code;
      window.dispatchEvent(new CustomEvent('avatok:locale', {detail: {locale: $code}}));
    ''');
  } catch (_) { /* Locale bridge failure must not block the form. */ }
}
