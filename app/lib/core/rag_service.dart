import 'dart:convert';

import 'api_auth.dart';
import 'ava_ai_store.dart';
import 'ava_contracts.dart';
import 'ava_log.dart';
import 'config.dart';

/// RagService — indexes the user's files + chat text into THEIR own Gemini File
/// Search store (created under their BYO key, stored in their free Google quota).
/// `@ava` then queries that store automatically (the Worker remembers the store
/// name per user). AvaTOK stores none of the content — the Worker is a
/// pass-through that forwards the user's key.
///
/// All calls are fire-and-forget friendly: they never throw out to the caller
/// and silently no-op when no key is connected (AI off), so wiring them into the
/// chat composer can never break sending a message.
class RagService {
  RagService._();
  static final RagService I = RagService._();

  final AvaAiStore _store = AvaAiStore();

  static String _url(String path) {
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    return '$origin$path';
  }

  Future<Map<String, String>> _keyHeader() async {
    final key = await _store.apiKey();
    return (key != null && key.isNotEmpty) ? {'X-Ava-Gemini-Key': key} : {};
  }

  /// Index a chunk of text (a note, or a batch of chat messages) into the store.
  /// [name] becomes the citation label. No-ops when AI isn't connected.
  Future<void> ingestText(String text, {String name = 'ava-memory'}) async {
    final t = text.trim();
    if (t.isEmpty) return;
    // Cloudflare AI Search (2026-06-18) is the store now and needs NO BYO Gemini
    // key — the server provisions a per-user instance and gates on premium. We
    // therefore ingest regardless of a key (the key header is still forwarded
    // when present, for the legacy path). Previously this returned early without
    // a Gemini key, so a premium user's chat/files were NEVER indexed — the root
    // cause of "@ava can't find my files." Best-effort: a non-premium user is
    // rejected server-side and the failure is swallowed.
    final headers = await _keyHeader();
    try {
      await ApiAuth.postJsonH(
        _url(AvaApi.ragIngest),
        {'text': t, 'name': name},
        headers,
        timeout: const Duration(seconds: 25),
      );
    } catch (e) {
      AvaLog.I.log('rag', 'ingestText failed: $e');
    }
  }

  /// Index a shared file/image (bytes) into the store. File Search supports
  /// text, PDF, Office docs and PNG/JPEG (multimodal); we skip anything else.
  Future<void> ingestFileBytes(List<int> bytes, String mime, String name) async {
    // The file picker hands us a generic mime; recover the real one from the
    // extension so File Search gets a type it understands.
    var m = mime;
    if (m.isEmpty || m == 'application/octet-stream') m = _mimeFromName(name);
    if (bytes.isEmpty || !_supported(m)) return;
    mime = m;
    // Keep within File Search's per-document limit and a sane upload size.
    if (bytes.length > 25 * 1024 * 1024) return;
    // Ingest regardless of a BYO key — Cloudflare AI Search is the store now and
    // is provisioned server-side (premium-gated). The key header is forwarded
    // when present. See [ingestText] for why the old key-gate was the bug.
    final headers = await _keyHeader();
    try {
      await ApiAuth.postJsonH(
        _url(AvaApi.ragIngest),
        {'name': name, 'mime': mime, 'contentB64': base64Encode(bytes)},
        headers,
        timeout: const Duration(seconds: 40),
      );
    } catch (e) {
      AvaLog.I.log('rag', 'ingestFileBytes failed: $e');
    }
  }

  String _mimeFromName(String name) {
    final n = name.toLowerCase();
    if (n.endsWith('.pdf')) return 'application/pdf';
    if (n.endsWith('.txt') || n.endsWith('.md') || n.endsWith('.csv')) return 'text/plain';
    if (n.endsWith('.json')) return 'application/json';
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
    if (n.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (n.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (n.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (n.endsWith('.doc')) return 'application/msword';
    return 'application/octet-stream';
  }

  bool _supported(String mime) {
    final m = mime.toLowerCase();
    return m == 'application/pdf' ||
        m.startsWith('text/') ||
        m == 'image/png' ||
        m == 'image/jpeg' ||
        m.contains('officedocument') || // docx/pptx/xlsx
        m == 'application/msword' ||
        m == 'application/json';
  }
}
