import 'dart:async';

import '../../core/analytics.dart';
import '../../core/apps_service.dart';
import '../../core/ava_local_mode.dart';
import '../../core/ava_local_replies.dart';
import '../../core/ava_log.dart';
import '../../core/ava_memory/ava_profile_memory.dart';
import '../../core/ava_ondevice_llm.dart';
import '../../core/ava_ondevice_rag.dart';
import '../../core/ava_quality.dart';
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

    // Let Ava learn from this request (topics, hours, style). Cheap + local.
    // ignore: unawaited_futures
    AvaProfileMemory.I.observeUserMessage(parsed.request);

    // Local Ava AI active → let the on-device router decide what to do. A LOCAL
    // lookup is answered on-device (offline, grounded in the user's own memory);
    // an APPS action runs through the user's connected apps; anything needing real
    // reasoning (CLOUD) — or any failure — falls through to the cloud agent.
    if (AvaLocalMode.I.isActive) {
      try {
        final answer = await _localAnswer(parsed.request);
        if (answer != null) {
          AvaLocalReplies.I.post(convKey, answer);
          return;
        }
        // answer == null → route said CLOUD: escalate below.
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

  /// On-device answer using the same router as AvaChat: route the request, then
  ///   • APPS  → run it through the user's connected apps (real tool result, no
  ///             hallucinated "I checked your email"),
  ///   • CLOUD → return null so [handle] escalates to the cloud agent for real
  ///             reasoning (the user's rule: retrieval local, reasoning cloud),
  ///   • LOCAL → retrieval-first, grounded reply from the on-device store; if
  ///             nothing matches, say so instead of inventing an answer.
  /// Returns the reply text, or null to mean "escalate to cloud".
  static Future<String?> _localAnswer(String request) async {
    final total = Stopwatch()..start();
    final q = request.replaceAll(RegExp(r'@ava!?', caseSensitive: false), '').trim();
    final query = q.isEmpty ? request : q;

    final rsw = Stopwatch()..start();
    final decision = await AvaOnDeviceLlm.I.route(query);
    final routeMs = rsw.elapsedMilliseconds;
    AvaLog.I.log('ava', 'route=${decision.scope} q="$query"');

    // APPS: the user wants an action in a connected app (check/send email, etc.).
    if (decision.isApps) {
      final tsw = Stopwatch()..start();
      final reply = await AppsService.I.run(query);
      final toolMs = tsw.elapsedMilliseconds;
      final lower = reply.toLowerCase();
      final succeeded = reply.isNotEmpty &&
          !lower.startsWith('top up') &&
          !lower.contains('something went wrong');
      AvaQuality.tool(
        tool: AvaQuality.toolGuess(query),
        succeeded: succeeded,
        ms: toolMs,
        reason: succeeded
            ? 'ok'
            : (lower.contains('top up') ? 'premium_required' : 'error'),
      );
      AvaQuality.answer(
        surface: 'ava_thread',
        source: 'tool',
        grounded: succeeded,
        sourcesFound: succeeded ? 1 : 0,
        ok: succeeded,
        userText: query,
      );
      // ignore: unawaited_futures
      Analytics.capture('ava_local_turn', {
        'scope': 'apps',
        'route_raw': decision.raw,
        'route_ms': routeMs,
        'total_ms': total.elapsedMilliseconds,
        'answered': reply.isNotEmpty,
      });
      return reply.isNotEmpty ? reply : null; // empty → let the cloud try
    }

    // CLOUD: real reasoning/analysis belongs on the server.
    if (decision.isCloud) {
      // ignore: unawaited_futures
      Analytics.capture('ava_local_turn', {
        'scope': 'cloud',
        'route_raw': decision.raw,
        'route_ms': routeMs,
        'total_ms': total.elapsedMilliseconds,
        'escalated': true,
      });
      return null;
    }

    // LOCAL: grounded retrieval from on-device memory.
    final ssw = Stopwatch()..start();
    final hits = await AvaOnDeviceRag.I.search(query, limit: 5);
    final searchMs = ssw.elapsedMilliseconds;
    if (hits.isEmpty) {
      AvaQuality.answer(
        surface: 'ava_thread',
        source: 'llm',
        grounded: false,
        sourcesFound: 0,
        userText: query,
      );
      // ignore: unawaited_futures
      Analytics.capture('ava_local_turn', {
        'scope': 'local',
        'route_raw': decision.raw,
        'route_ms': routeMs,
        'search_ms': searchMs,
        'hits': 0,
        'total_ms': total.elapsedMilliseconds,
      });
      return "I don't have anything about that in this device's memory yet.";
    }
    final ctx = hits.map((h) => '• (${h.source}) ${h.content}').join('\n');
    final about = await AvaProfileMemory.I.contextBlock();
    final gsw = Stopwatch()..start();
    final reply = await AvaOnDeviceLlm.I.ask(
      query,
      system: about.isEmpty ? null : '${AvaOnDeviceLlm.kChatSystem}\n\n$about',
      context: ctx,
      maxTokens: 160,
    );
    final genMs = gsw.elapsedMilliseconds;
    AvaQuality.answer(
      surface: 'ava_thread',
      source: about.isEmpty ? 'rag' : 'hybrid',
      grounded: true,
      citations: hits.length,
      memoryUsed: about.isNotEmpty,
      sourcesFound: hits.length,
      ok: reply.ok,
      systemText: about,
      ragText: ctx,
      userText: query,
    );
    // ignore: unawaited_futures
    Analytics.capture('ava_local_turn', {
      'scope': 'local',
      'route_raw': decision.raw,
      'route_ms': routeMs,
      'search_ms': searchMs,
      'gen_ms': genMs,
      'hits': hits.length,
      'ok': reply.ok,
      'total_ms': total.elapsedMilliseconds,
    });
    if (reply.ok && reply.text.isNotEmpty) return reply.text;
    return ctx; // generation failed but we have real matches — show those
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
