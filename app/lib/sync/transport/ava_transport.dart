import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb, defaultTargetPlatform, TargetPlatform;

import '../../core/feature_flags.dart';

/// ── AvaTransport: the realtime-messaging seam (Ably migration) ───────────────
///
/// The app historically spoke one transport: the per-user Cloudflare `InboxDO`
/// WebSocket (see `SyncHub`, `AvaDm`, `PresenceChannel`). Its presence layer
/// (typing / online / receipts) rode the same socket and was unreliable.
///
/// This interface is the single seam every realtime transport implements, so the
/// rest of the app (chat list, threads, presence UI) is provider-agnostic. Two
/// implementations exist:
///   • `InboxTransport`  — the legacy Cloudflare InboxDO socket (default).
///   • `AblyTransport`   — Ably Pub/Sub realtime (iOS + Android only).
///
/// IMPORTANT — platform reality: the official `ably_flutter` package wraps Ably's
/// native cocoa/java SDKs, so it runs on **iOS and Android only**. There is no
/// Ably support for Flutter desktop / macOS / web. [useAblyTransport] therefore
/// returns false on every non-mobile platform and the app stays on the legacy
/// InboxDO transport there. This is by design, not a TODO.
///
/// Selection precedence (highest first):
///   1. platform must be iOS or Android (else InboxDO),
///   2. the server kill switch `PlatformConfig.messagingProvider` (fetched into
///      [RuntimeMessagingProvider]) — lets us flip everyone back without a build,
///   3. the compile-time default [kMessagingProvider].
abstract class AvaTransport {
  /// Begin connecting / subscribing. Idempotent.
  Future<void> start();

  /// Durable conversation messages (text + media envelopes), already mapped to
  /// the app's conv-key convention ('1:<peerUid>' DM, 'g:<gid>' group).
  Stream<TransportMessage> get messages;

  /// Ephemeral "X is typing…" — never persisted.
  Stream<TypingEvent> get typing;

  /// Online / last-seen presence transitions.
  Stream<PresenceEvent> get presence;

  /// Delivered / read receipts (the double-tick), delivered on a side channel —
  /// deliberately NOT mixed into [messages] (fixes the legacy "receipt envelopes
  /// leak into the message stream" bug by construction).
  Stream<ReceiptEvent> get receipts;

  /// Publish a message to [convKey]; returns the optimistic client id used as the
  /// echo-dedupe key (mirrors `AvaDm.send`).
  String sendText(String convKey, String payload);

  /// Tell the peer/room we delivered or read up to [ts]. [status] is
  /// 'delivered' | 'read'.
  void sendReceipt(String convKey, String status, int ts);

  /// Start/stop the local typing indicator on [convKey].
  void setTyping(String convKey, bool on);

  /// Enter/leave presence for the signed-in account.
  void setOnline(bool online);

  /// App returned to the foreground — verify the connection is live (cheap).
  void onResumed();

  /// Tear down all subscriptions/connections.
  void dispose();
}

/// A durable message as seen by the app, transport-neutral.
class TransportMessage {
  final String convKey;     // '1:<peerUid>' | 'g:<gid>'
  final String senderUid;
  final bool mine;
  final String rumorId;     // client_id (optimistic dedupe) or 'srv_<id>'
  final String payload;     // app envelope JSON (text/media)
  final int createdAt;      // unix seconds
  const TransportMessage(this.convKey, this.senderUid, this.mine, this.rumorId,
      this.payload, this.createdAt);
}

class TypingEvent {
  final String convKey;
  final String who;
  final bool on;
  const TypingEvent(this.convKey, this.who, this.on);
}

class PresenceEvent {
  final String uid;
  final bool online;
  final int lastSeen; // unix seconds; 0 when online/unknown
  const PresenceEvent(this.uid, this.online, this.lastSeen);
}

class ReceiptEvent {
  final String convKey;
  final String status; // 'delivered' | 'read'
  final int ts;
  const ReceiptEvent(this.convKey, this.status, this.ts);
}

/// Runtime kill switch mirror. The app fetches `/api/config` at launch; if it
/// returns `messagingProvider`, set it here so it overrides the compile-time
/// default. Until set, [value] is null and the compile-time flag wins.
class RuntimeMessagingProvider {
  static String? value;
}

/// True only on a mobile platform where Ably's native SDK exists AND the
/// resolved provider is 'ably'. Every other case → legacy InboxDO transport.
bool useAblyTransport() {
  if (kIsWeb) return false;
  if (!(_isIOS || _isAndroid)) return false; // no Ably for desktop/macOS/web
  final provider = RuntimeMessagingProvider.value ?? kMessagingProvider;
  return provider == 'ably';
}

// Platform probes. `defaultTargetPlatform` works on every Flutter target
// (including web, where the mobile branches simply never match), so we avoid a
// hard `dart:io` import that would break the web build.
bool get _isAndroid => !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
bool get _isIOS => !kIsWeb && defaultTargetPlatform == TargetPlatform.iOS;
