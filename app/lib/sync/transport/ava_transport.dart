import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show kIsWeb, defaultTargetPlatform, TargetPlatform;

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
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

  /// Phase 3 (ABLY-R2): deep history page from the Cloudflare archive (R2 + D1),
  /// for messages OLDER than Ably's live window. Transport-agnostic HTTP, so it's
  /// a concrete shared method (both transports inherit it). [beforeSerial] is the
  /// exclusive cursor returned as [ArchivePage.nextBefore]; null loads the newest
  /// archived page. Returns an empty page on any error (caller keeps local cache).
  Future<ArchivePage> history(String convKey, String myUid,
      {String? beforeSerial, int limit = 30}) async {
    final conv = serverConvFromKey(convKey, myUid);
    if (conv == null) return const ArchivePage(<TransportMessage>[], null);
    try {
      final qp = <String, String>{'conv': conv, 'limit': '$limit'};
      if (beforeSerial != null && beforeSerial.isNotEmpty) qp['before'] = beforeSerial;
      final uri = Uri.parse(kMsgArchiveUrl).replace(queryParameters: qp);
      final res = await ApiAuth.getSigned(uri.toString());
      if (res.statusCode != 200) {
        Analytics.capture('chat_archive_fetch_failed', {'status': res.statusCode});
        return const ArchivePage(<TransportMessage>[], null);
      }
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final list = (body['messages'] as List? ?? const []);
      final msgs = <TransportMessage>[];
      for (final m in list) {
        final mm = (m as Map).cast<String, dynamic>();
        final sender = (mm['sender'] ?? '').toString();
        // Dedupe key = the shared client_id (same value the live message used as
        // its rumorId/evId), so scroll-up history merges cleanly with what's on
        // screen. Falls back to the server serial when no client_id was stored.
        final cid = (mm['client_id'] ?? '').toString();
        msgs.add(TransportMessage(
          convKey, sender, sender == myUid,
          cid.isNotEmpty ? cid : 'srv_${mm['serial']}',
          (mm['body'] ?? '').toString(),
          ((mm['created_at'] as num?)?.toInt() ?? 0) ~/ 1000,
        ));
      }
      Analytics.capture('chat_archive_page', {'conv': conv, 'count': msgs.length, 'paged': beforeSerial != null});
      return ArchivePage(msgs, body['nextBefore']?.toString());
    } catch (e) {
      Analytics.capture('chat_archive_fetch_error', {'err': e.toString()});
      return const ArchivePage(<TransportMessage>[], null);
    }
  }

  // ── Phase 4 (ABLY-R2): reactions · bursts · occupancy ──────────────────────
  // Live delivery is Ably-native (AblyTransport overrides the streams + the live
  // publish). The base persists reactions over HTTP so the legacy transport still
  // saves them; bursts/occupancy degrade to no-ops off Ably.

  /// Toggle a per-message reaction. Persists via the worker (durable summary);
  /// AblyTransport ALSO publishes it live to the react:<conv> channel.
  Future<void> sendReaction(String convKey, String myUid, String targetSerial,
      String emoji, {bool add = true, String whoName = ''}) async {
    // whoName is a display-name hint carried only on the LIVE Ably frame
    // (AblyTransport) so peers can name the reactor; the durable worker summary
    // doesn't need it. The base persists without it.
    final conv = serverConvFromKey(convKey, myUid);
    if (conv == null) return;
    try {
      await ApiAuth.postJson(kMsgReactUrl,
          {'conv': conv, 'target': targetSerial, 'emoji': emoji, 'op': add ? 'add' : 'remove'});
      Analytics.capture('chat_reaction_sent', {'emoji': emoji, 'add': add});
    } catch (e) {
      Analytics.capture('chat_reaction_error', {'err': e.toString()});
    }
  }

  /// Live per-message reaction events from peers (empty off Ably).
  Stream<ReactionEvent> get reactions => const Stream<ReactionEvent>.empty();

  /// Send an ephemeral floating-emoji burst to the room (no-op off Ably).
  void sendBurst(String convKey, String emoji) {}

  /// Live burst events from the room (empty off Ably).
  Stream<BurstEvent> get bursts => const Stream<BurstEvent>.empty();

  /// Start tracking live occupancy for [convKey] (no-op off Ably).
  void watchOccupancy(String convKey) {}

  /// Live occupancy counts for watched rooms (empty off Ably).
  Stream<OccupancyEvent> get occupancy => const Stream<OccupancyEvent>.empty();
}

/// A live per-message reaction toggle from a peer.
class ReactionEvent {
  final String convKey;
  final String targetSerial; // message reacted to
  final String who;          // reactor uid
  final String emoji;
  final bool add;            // true = added, false = removed
  final String whoName;      // reactor display name (live hint; '' if unknown)
  const ReactionEvent(this.convKey, this.targetSerial, this.who, this.emoji, this.add,
      [this.whoName = '']);
}

/// An ephemeral floating-emoji burst (not persisted).
class BurstEvent {
  final String convKey;
  final String who;
  final String emoji;
  const BurstEvent(this.convKey, this.who, this.emoji);
}

/// Live occupancy for a room: how many members are currently present.
class OccupancyEvent {
  final String convKey;
  final int present;
  const OccupancyEvent(this.convKey, this.present);
}

/// A page of archived history (newest-first) + the cursor for the next older page.
class ArchivePage {
  final List<TransportMessage> messages;
  final String? nextBefore; // pass back as beforeSerial; null = no more history
  const ArchivePage(this.messages, this.nextBefore);
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
