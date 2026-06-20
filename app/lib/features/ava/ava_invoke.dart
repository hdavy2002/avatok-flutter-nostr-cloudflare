import 'dart:async';

import '../../core/ava_local_mode.dart';
import '../../core/ava_local_replies.dart';
import '../../core/ava_log.dart';
import '../../core/ava_ondevice_llm.dart';
import '../../core/ava_ondevice_rag.dart';
import 'ava_turn_controller.dart';

/// AvaInvoke (Phase 3 — In-Thread Ava Spine).
///
/// The `@ava` parse + handler. The FROZEN chat composer (chat_thread.dart)
/// exposes a nullable `onSummonAva` (`Future<void> Function(String text)?`) which
/// `_send` calls when the outgoing text contains the wake word `@ava`. This file
/// provides the behaviour to attach to that hook.
///
/// Wiring (the composer hook lives on the chat-thread STATE, which is frozen):
/// at the construction site of `ChatThreadScreen` (owned by the chat-screen /
/// Phase 11 owner — NOT a Phase-3 file), bind the per-conversation handler once
/// the state + convKey are known, e.g. via a GlobalKey or in the state's
/// initState:
///
///     // after the thread's convKey is resolved:
///     state.onSummonAva = AvaInvoke.makeHandler(convKey);
///
/// See Specs/ava-build/INTEGRATION-NOTES.md (Phase 3) for the exact one-liner.
class AvaInvoke {
  AvaInvoke._();

  /// The wake word the composer watches for. Mirrors `_avaWakeWord` in
  /// chat_thread.dart (kept here so this file is self-contained).
  static const String wakeWord = '@ava';

  /// Build a composer handler bound to a specific [convKey] ('1:<peerUid>' for a
  /// DM, 'g:<gid>' for a group). Assign the result to a chat-thread state's
  /// `onSummonAva`. Returns a function the composer can fire-and-forget.
  static Future<void> Function(String text) makeHandler(String convKey) {
    return (String text) => handle(convKey: convKey, text: text);
  }

  /// Parse a composer line and run the turn. Idempotent-safe: a turn already in
  /// flight for [convKey] is skipped (the controller guards this).
  ///
  /// Private-reply syntax: a leading `@ava private …` (or `@ava!`/`@ava (private)`)
  /// asks Ava to answer ONLY the caller via `ava_private`. Otherwise Ava posts a
  /// normal `ava` bubble visible to all participants.
  static Future<void> handle({required String convKey, required String text}) async {
    final parsed = parse(text);
    if (parsed == null) return; // no wake word — nothing to do
    AvaLog.I.log('ava', 'summon conv=$convKey private=${parsed.privateReply}');

    // Local Ava AI active → answer ON-DEVICE (works offline) and post the answer
    // straight into the thread, no server round-trip. Falls back to the cloud
    // agent on any failure.
    if (AvaLocalMode.I.isActive) {
      try {
        final answer = await _localAnswer(parsed.request);
        AvaLocalReplies.I.post(convKey, answer);
        return;
      } catch (e) {
        AvaLog.I.log('ava', 'local answer failed → cloud: $e');
      }
    }

    await AvaTurnController.I.summon(
      convKey: convKey,
      text: parsed.request,
      privateReply: parsed.privateReply,
    );
  }

  /// Retrieval-first on-device answer: search the on-device store, then a short
  /// grounded reply. Keeps it fast (no long generation).
  static Future<String> _localAnswer(String request) async {
    final q = request.replaceAll(RegExp(r'@ava!?', caseSensitive: false), '').trim();
    final hits = await AvaOnDeviceRag.I.search(q.isEmpty ? request : q, limit: 5);
    if (hits.isEmpty) {
      return "I couldn't find anything about that in this device's memory yet.";
    }
    final ctx = hits.map((h) => '• ${h.content}').join('\n');
    final reply = await AvaOnDeviceLlm.I.ask(q.isEmpty ? request : q, context: ctx, maxTokens: 96);
    return (reply.ok && reply.text.isNotEmpty) ? reply.text : ctx;
  }

  /// Parse [text] for the wake word and the optional private modifier. Returns
  /// null when the wake word is absent. The full request (still containing the
  /// wake word) is forwarded to the worker, which treats it as untrusted data.
  static AvaInvokeParse? parse(String text) {
    final lower = text.toLowerCase();
    final idx = lower.indexOf(wakeWord);
    if (idx < 0) return null;

    // Look at what immediately follows the wake word for a private modifier.
    final after = text.substring(idx + wakeWord.length).trimLeft();
    final afterLower = after.toLowerCase();
    final private = text.substring(idx, idx + wakeWord.length + 1) == '$wakeWord!' ||
        afterLower.startsWith('private') ||
        afterLower.startsWith('(private)');

    return AvaInvokeParse(request: text.trim(), privateReply: private);
  }
}

/// Result of [AvaInvoke.parse].
class AvaInvokeParse {
  /// The text forwarded to the agent (the worker treats it as a request, not a
  /// system instruction).
  final String request;

  /// Whether the user asked for a private (`ava_private`) reply.
  final bool privateReply;

  const AvaInvokeParse({required this.request, required this.privateReply});
}
