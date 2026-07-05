import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pdfx/pdfx.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/ui/zine.dart';

/// [CHAT-PDFVIEW-1] In-app viewer for downloaded/decrypted chat attachments.
///
/// The old file-bubble tap did `launchUrl(external)` on a `file://` URL, which on
/// Android fails SILENTLY when no app claims the type — the user tapped and
/// "nothing happened". This screen renders PDFs (pinch-zoom + page indicator) and
/// images (interactive zoom) IN-APP, and for every other type hands off to the OS
/// open sheet with a clear error when no handler exists. A share action is always
/// available in the app bar.
///
/// Bytes are already plaintext (decrypted upstream by MediaService), so this
/// screen never touches the network or crypto — it just renders + shares.
class FileViewerScreen extends StatefulWidget {
  const FileViewerScreen({
    super.key,
    required this.bytes,
    required this.name,
    required this.mime,
  });

  final Uint8List bytes;
  final String name;
  final String mime;

  /// True when we can render this type in-app (pdf or image).
  static bool canView(String mime, String name) => _isPdf(mime, name) || _isImage(mime, name);

  static bool _isPdf(String mime, String name) =>
      mime.toLowerCase().contains('pdf') || name.toLowerCase().endsWith('.pdf');

  static bool _isImage(String mime, String name) {
    final m = mime.toLowerCase();
    if (m.startsWith('image/')) return true;
    final n = name.toLowerCase();
    return n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg') ||
        n.endsWith('.gif') || n.endsWith('.webp') || n.endsWith('.bmp');
  }

  @override
  State<FileViewerScreen> createState() => _FileViewerScreenState();
}

class _FileViewerScreenState extends State<FileViewerScreen> {
  PdfControllerPinch? _pdf;
  int _page = 1;
  int _pages = 0;
  bool _pdfError = false;
  bool _sharing = false;

  bool get _isPdf => FileViewerScreen._isPdf(widget.mime, widget.name);

  @override
  void initState() {
    super.initState();
    Analytics.capture('chat_file_opened', {'mime': widget.mime, 'in_app': true});
    if (_isPdf) {
      try {
        _pdf = PdfControllerPinch(document: PdfDocument.openData(widget.bytes));
      } catch (e) {
        AvaLog.I.log('media', 'pdf viewer open failed: $e');
        _pdfError = true;
      }
    }
  }

  @override
  void dispose() {
    _pdf?.dispose();
    super.dispose();
  }

  Future<void> _share() async {
    if (_sharing) return;
    setState(() => _sharing = true);
    try {
      final dir = await getTemporaryDirectory();
      final safe = widget.name.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');
      final f = File('${dir.path}/${DateTime.now().millisecondsSinceEpoch}_$safe');
      await f.writeAsBytes(widget.bytes, flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: widget.mime)]);
    } catch (e) {
      AvaLog.I.log('media', 'file viewer share failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text("Couldn't share this file")));
      }
    } finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Zine.ink,
        foregroundColor: Colors.white,
        title: Text(widget.name,
            maxLines: 1, overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: Colors.white, fontSize: 15)),
        actions: [
          if (_isPdf && _pages > 0)
            Center(
                child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Text('$_page / $_pages',
                  style: const TextStyle(color: Colors.white70, fontSize: 13)),
            )),
          IconButton(
            tooltip: 'Share',
            icon: _sharing
                ? const SizedBox(
                    width: 18, height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Icon(Icons.ios_share_rounded),
            onPressed: _sharing ? null : _share,
          ),
        ],
      ),
      body: _isPdf ? _pdfBody() : _imageBody(),
    );
  }

  Widget _pdfBody() {
    if (_pdfError || _pdf == null) {
      return _errorState("Couldn't open this PDF");
    }
    return PdfViewPinch(
      controller: _pdf!,
      onDocumentLoaded: (doc) {
        if (mounted) setState(() => _pages = doc.pagesCount);
      },
      onPageChanged: (p) {
        if (mounted) setState(() => _page = p);
      },
      builders: PdfViewPinchBuilders<DefaultBuilderOptions>(
        options: const DefaultBuilderOptions(),
        documentLoaderBuilder: (_) =>
            const Center(child: CircularProgressIndicator(color: Colors.white)),
        pageLoaderBuilder: (_) =>
            const Center(child: CircularProgressIndicator(color: Colors.white)),
        errorBuilder: (_, __) => _errorState("Couldn't render this PDF"),
      ),
    );
  }

  Widget _imageBody() {
    return InteractiveViewer(
      minScale: 1,
      maxScale: 5,
      child: Center(
        child: Image.memory(
          widget.bytes,
          fit: BoxFit.contain,
          errorBuilder: (_, __, ___) => _errorState("Couldn't display this image"),
        ),
      ),
    );
  }

  Widget _errorState(String msg) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.error_outline_rounded, color: Colors.white54, size: 40),
            const SizedBox(height: 12),
            Text(msg, textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white70)),
            const SizedBox(height: 16),
            TextButton.icon(
              onPressed: _share,
              icon: const Icon(Icons.ios_share_rounded, color: Colors.white),
              label: const Text('Share / open elsewhere',
                  style: TextStyle(color: Colors.white)),
            ),
          ]),
        ),
      );
}

/// Hands a non-viewable file to the OS open-with sheet. Returns false (and the
/// caller shows a clear snackbar) when no app on the device can open the type —
/// the exact silent-failure the old `launchUrl(external)` produced.
Future<bool> openFileWithOs(Uint8List bytes, String name, String mime) async {
  try {
    final dir = await getTemporaryDirectory();
    final safe = name.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');
    final f = File('${dir.path}/${DateTime.now().millisecondsSinceEpoch}_$safe');
    await f.writeAsBytes(bytes, flush: true);
    final ok = await launchUrl(Uri.file(f.path), mode: LaunchMode.externalApplication);
    Analytics.capture('chat_file_opened', {'mime': mime, 'in_app': false, 'os_ok': ok});
    return ok;
  } catch (e) {
    AvaLog.I.log('media', 'os open failed: $e');
    Analytics.capture('chat_file_opened', {'mime': mime, 'in_app': false, 'os_ok': false});
    return false;
  }
}
