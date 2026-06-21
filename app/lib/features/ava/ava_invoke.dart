import 'dart:async';

import '../../core/analytics.dart';
import '../../core/ava_local_mode.dart';
import '../../core/ava_local_replies.dart';
import '../../core/ava_log.dart';
import '../../core/ava_memory/ava_profile_memory.dart';
import '../../core/ava_ondevice_llm.dart';
import '../../core/ava_ondevice_rag.dart';
import '../../core/ava_planner.dart';
import '../../core/ava_prompt_budget.dart';
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

    // Local Ava AI active → answer ONLY a clear OFFLINE memory lookup on-device.
    // For EVERYTHING else (actions, app/tool requests, or anything that needs
    // real understanding) we escalate to the cloud agent (ava_agent.ts: Gemma 4
    // LLM intent + Composio tool-calling). The tiny 350M is NOT trusted to
    // classify intent — telemetry showed it returns garbage, which is what made
    // it hallucinate a fake email. Intent understanding is the capable LLM's job.
    if (AvaLocalMode.I.isActive) {
      try {
        final answer = await _localAnswer(parsed.request);
        if (answer != null) {
          AvaLocalReplies.I.post(convKey, answer);
          return;
        }
        // answer == null → not a clear local lookup; escalate to the cloud agent.
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

  /// Answer ONLY a clear, offline memory lookup ("what did I note about X")
  /// from the on-device store. Returns null for everything else so [handle]
  /// escalates to the cloud agent, which does proper LLM intent understanding
  /// AND real tool-calling (Gmail/Calendar/Drive). We never let the 350M decide
  /// whether to call a tool — that's exactly the mistake that hallucinated an
  /// email from notes.
  static Future<String?> _localAnswer(String request) async {
    final total = Stopwatch()..start();
    final q = request.replaceAll(RegExp(r'@ava!?', caseSensitive: false), '').trim();
    final query = q.isEmpty ? request : q;

    final plan = AvaPlanner.plan(query);
    final isLocalLookup = plan != null &&
        plan.scope == PlanScope.local &&
        plan.confidence >= AvaPlanner.kExecuteThreshold;

    if (!isLocalLookup) {
      // Not a clear offline lookup → the cloud agent understands intent + acts.
      // ignore: unawaited_futures
      Analytics.capture('ava_local_turn', {
        'scope': 'cloud',
        'route_raw': plan != null ? 'planner:${plan.intent}' : 'escalate',
        'escalated': true,
        'total_ms': total.elapsedMilliseconds,
      });
      return null;
    }

    // Clear offline memory lookup — answer from on-device RAG, grounded.
    final ssw = Stopwatch()..start();
    final hits = await AvaOnDeviceRag.I.search(query, limit: 5);
    final searchMs = ssw.elapsedMilliseconds;
    if (hits.isEmpty) {
      // Nothing on-device → let the cloud agent try (it has the user's store)
      // instead of a dead-end "I don't have it".
      // ignore: unawaited_futures
      Analytics.capture('ava_local_turn', {
        'scope': 'cloud',
        'route_raw': 'local_miss',
        'search_ms': searchMs,
        'hits': 0,
        'escalated': true,
        'total_ms': total.elapsedMilliseconds,
      });
      return null;
    }
    // Hard token budget so the prompt stays small no matter how much memory grows.
    final ctx = AvaPromptBudget.rag(
        hits.map((h) => '• (${h.source}) ${h.content}').join('\n'));
    final about = AvaPromptBudget.memory(await AvaProfileMemory.I.contextBlock());
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
    AvaQuality.roi(
      surface: 'ava_thread',
      retrieved: hits.length,
      injected: ctx,
      answer: reply.ok ? reply.text : ctx,
    );
    // ignore: unawaited_futures
    Analytics.capture('ava_local_turn', {
      'scope': 'local',
      'route_raw': 'planner:${plan.intent}',
      'search_ms': searchMs,
      'gen_ms': genMs,
      'hits': hits.length,
      'ok': reply.ok,
      'total_ms': total.elapsedMilliseconds,
    });
    if (reply.ok && reply.text.isNotEmpty) return reply.text;
    return null; // generation failed → escalate to the cloud agent
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
