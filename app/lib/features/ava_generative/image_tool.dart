/// The REAL `image.generate` AvaTool (Phase 9 — Generative).
///
/// P5 registered a "coming soon" SHIM under the same name in
/// `core/ava_tools/core_tools.dart` (which Phase 9 does NOT edit). This file
/// provides the real implementation and a [registerImageTool] that
/// `ToolRegistry.register(...)`s it. Because the registry keys by tool name and
/// `register` REPLACES by name, registering this AFTER `registerCoreTools()`
/// (the bootstrap call order) SUPERSEDES P5's shim with the live tool — no edit
/// to core_tools.dart required.
///
/// The tool POSTs to [AvaApi.image] (`/api/ava/image`). Generation is async and
/// in-thread: the worker drops the "Ava is generating…" chip immediately, the
/// HTTP call returns fast, and the finished image arrives as an `ava` message in
/// the SAME conversation (rendered by the frozen chat_thread.dart). So this
/// tool's `invoke` only KICKS OFF the job — it returns a `{status:'generating'}`
/// acknowledgement rather than the image bytes.
///
/// Premium: the tool declares `paid:true` (inherited contract). The actual
/// wallet gate is applied at the UI invocation point ([ImageRequestSheet] wraps
/// the kickoff in [PaidFeature]); the in-chat tool-call path relies on the same
/// server-side gating that fronts every Ava turn.
library;

import 'dart:convert';

import '../../core/api_auth.dart';
import '../../core/ava_ai_store.dart';
import '../../core/ava_contracts.dart';
import '../../core/ava_tools/ava_tool.dart';
import '../../core/config.dart';

/// Build the full `/api/ava/image` URL from the API origin + the Phase-0 path
/// (mirrors AvaTurnController._turnUrl so the path is never re-declared).
String avaImageUrl() {
  final origin = kApiBase.endsWith('/api')
      ? kApiBase.substring(0, kApiBase.length - '/api'.length)
      : kApiBase;
  return '$origin${AvaApi.image}';
}

/// Kick off an async in-thread image generation. Resolves the local [convKey]
/// ('1:<peerUid>' | 'g:<gid>') to the server conv id, sends the prompt (+ an
/// optional edit reference), and returns the parsed worker response. The image
/// itself arrives later as an `ava` message in the conversation.
Future<Map<String, Object?>> requestAvaImage({
  required String convKey,
  required String prompt,
  String? editMediaRef,
  Duration timeout = const Duration(seconds: 30),
}) async {
  final myUid = AccountScope.id;
  if (myUid == null || myUid.isEmpty) {
    return {'error': 'no_account_scope'};
  }
  final conv = serverConvFromKey(convKey, myUid);
  if (conv == null) return {'error': 'unresolved_conv', 'convKey': convKey};

  final body = <String, dynamic>{
    'conv': conv,
    'prompt': prompt,
    if (editMediaRef != null && editMediaRef.isNotEmpty)
      'edit': {'media_ref': editMediaRef},
  };

  // Forward the BYO Gemini key per-request (header, never the body) so a user
  // with their own key uses it; otherwise the worker uses its server key.
  final extra = <String, String>{};
  final key = await AvaAiStore().apiKey();
  if (key != null && key.isNotEmpty) extra['X-Ava-Gemini-Key'] = key;

  try {
    final res = await ApiAuth.postJsonH(avaImageUrl(), body, extra, timeout: timeout);
    Map<String, dynamic> j;
    try {
      j = jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      j = const {};
    }
    if (res.statusCode != 200) {
      return {
        'status': 'error',
        'code': res.statusCode,
        'error': (j['error'] as String?) ?? 'http_${res.statusCode}',
      };
    }
    return j.cast<String, Object?>();
  } catch (e) {
    return {'status': 'error', 'error': 'network', 'detail': e.toString()};
  }
}

/// The REAL image.generate tool — supersedes P5's shim by name.
class ImageGenerateToolReal implements AvaTool {
  @override
  String get name => 'image.generate';
  @override
  String get description => 'Generate (or edit) an image from a text prompt; it arrives in the chat.';
  @override
  String get whenToUse => 'When the user asks Ava to create, draw, or edit a picture, logo, sticker or meme.';

  /// Premium — the UI wraps the kickoff in PaidFeature; the broker/UI show the
  /// PaidBadge from this flag.
  @override
  bool get paid => true;

  @override
  Map<String, Object?> get parameters => {
        'prompt': {'type': 'string', 'description': 'What to draw / how to edit', 'required': true},
        'edit_media_ref': {
          'type': 'string',
          'description': 'Optional URL of an existing image to edit instead of generating fresh',
        },
      };

  @override
  Future<Map<String, Object?>> invoke(Map<String, Object?> args, {required AvaToolContext ctx}) async {
    final prompt = (args['prompt'] ?? '').toString().trim();
    if (prompt.isEmpty) return {'error': 'prompt required'};
    final convKey = ctx.convKey;
    if (convKey == null || convKey.isEmpty) {
      // Image gen is in-thread by design — it needs a conversation to land in.
      return {'status': 'no_conversation', 'note': 'Image generation posts into a chat; open one first.'};
    }
    final editRef = args['edit_media_ref']?.toString();
    final out = await requestAvaImage(convKey: convKey, prompt: prompt, editMediaRef: editRef);
    if (out['ok'] == true || out['async'] == true) {
      return {
        'status': 'generating',
        'note': 'Generating your image — it will appear in the chat shortly.',
        if (out['status_id'] != null) 'status_id': out['status_id'],
      };
    }
    if (out['blocked'] == true) {
      return {
        'status': 'blocked',
        'reason': out['reason'],
        'note': (out['message'] ?? "I can't create that image.").toString(),
      };
    }
    return out;
  }
}

/// Register the real image.generate tool — call AFTER registerCoreTools() so it
/// supersedes P5's shim (ToolRegistry.register replaces by name). Idempotent.
void registerImageTool() {
  ToolRegistry.register(ImageGenerateToolReal());
}
