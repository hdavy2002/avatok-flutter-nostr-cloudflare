import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:app_badge_plus/app_badge_plus.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/account_storage.dart';
import '../core/analytics.dart';
import '../core/api_auth.dart';
import '../core/ava_log.dart';
import '../core/call_log_store.dart';
import '../core/calls/call_overlay.dart' show returnToActiveCall;
import '../core/calls/callkit_params.dart' show incomingCallAndroidParams;
import '../core/calls/call_session_manager.dart';
import '../core/config.dart';
import '../core/disk_cache.dart';
import '../core/ice_cache.dart';
import '../features/avatok/call_screen.dart';
import '../sync/sync_hub.dart';

/// Global key so we can navigate to the call screen when a call is accepted.
final navigatorKey = GlobalKey<NavigatorState>();

/// Broadcasts call-status updates (declined / busy / ended) pushed by the server
/// to the active CallScreen — reliable even when the WS path couldn't be held.
///
/// [BUSY-CARD-1] The optional busy metadata (`busyReason`, `receptionistEnabled`,
/// `pronoun`) is carried ONLY on a `busy` status when the server provides it. It
/// drives the personalized busy card (Specs §3.1). When absent (old server /
/// kill switch off) these are null/false and the caller falls back to the plain
/// "User is busy" line — existing behaviour is unchanged.
typedef CallStatusEvent = ({
  String callId,
  String status,
  String? busyReason,
  bool receptionistEnabled,
  String? pronoun,
});
final callStatusBus = StreamController<CallStatusEvent>.broadcast();

// CALLFIX-14: Glare detection — track the currently ringing incoming call so if
// the user starts dialing while an incoming call from the same peer is ringing,
// we can auto-accept the incoming call instead. Cleared when the call is
// accepted/declined/missed.
String? gIncomingRingingFrom; // the peer's uid/seed that is currently ringing
String? gIncomingRingingCallId; // the callId of the incoming call

final _local = FlutterLocalNotificationsPlugin();
// Messages channel. Keep the id 'avatok_messages' UNCHANGED — changing a channel
// id makes Android drop the old channel and create a fresh one, resetting the
// user's sound/vibration/importance overrides. playSound + enableVibration are set
// EXPLICITLY so the OS is guaranteed to raise a heads-up banner that wakes the
// screen with sound + vibration (importance high alone is necessary but the
// explicit flags remove any ambiguity across OEM skins).
const _msgChannel = AndroidNotificationChannel(
  'avatok_messages', 'Messages',
  description: 'New message notifications', importance: Importance.high,
  playSound: true, enableVibration: true,
);

// Calls channel — missed calls and receptionist ("Ava took a message") banners.
// Separate id so the user can tune/mute call notifications independently of chat,
// and so a missed-call banner reads distinctly from a chat message. Also high
// importance with sound + vibration so it wakes the screen.
const _callsChannel = AndroidNotificationChannel(
  'avatok_calls', 'Calls',
  description: 'Missed calls and receptionist messages', importance: Importance.high,
  playSound: true, enableVibration: true,
);

// The BACKGROUND FCM isolate is a SEPARATE Dart isolate with none of the app's
// startup wiring. `_local` here is a fresh, UNINITIALIZED plugin instance, and
// calling `_local.show()` on it without `initialize()` throws natively — which
// is why the app appeared to "crash on every FCM" while backgrounded. Worse, the
// bg isolate has no PostHog, so those crashes were INVISIBLE in telemetry. The
// two helpers below fix both: idempotently initialize `_local` in whichever
// isolate is about to show a banner, and durably record bg events/errors to a
// device-level queue the main isolate ships to PostHog on next foreground.
bool _localReady = false;
Future<void> _ensureLocalInit() async {
  if (_localReady) return;
  try {
    await _local.initialize(const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
    ));
    final android = _local
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    await android?.createNotificationChannel(_msgChannel);
    await android?.createNotificationChannel(_callsChannel);
    _localReady = true;
  } catch (_) {/* leave false so the next push retries init */}
}

const _kPendingBgTelemetry = 'pending_bg_telemetry';
Future<void> _bgTrack(String event, Map<String, dynamic> props) async {
  try {
    final raw = await DiskCache.readGlobal(_kPendingBgTelemetry);
    final list = (raw == null || raw.isEmpty) ? <dynamic>[] : (jsonDecode(raw) as List);
    list.add({'event': event, 'props': props, 'ts': DateTime.now().millisecondsSinceEpoch});
    if (list.length > 60) list.removeRange(0, list.length - 60); // cap the queue
    await DiskCache.writeGlobal(_kPendingBgTelemetry, jsonEncode(list));
  } catch (_) {/* best-effort; telemetry must never itself crash the handler */}
}

// --- Unread app-icon badge (red dot + count, WhatsApp-style) ----------------
// Device-level (NOT per-account): the launcher badge is one OS-level affordance
// for the whole phone, and it's a transient count cleared the moment the app is
// opened — not durable per-user data — so a device key is correct here (the
// account-scoping rule's explicit exception for device-level values). Stored in
// secure storage so the BACKGROUND isolate (no app state) can read + bump it.
const _kBadgeKey = 'avatok_badge_count';
const _badgeStore = FlutterSecureStorage(mOptions: MacOsOptions(useDataProtectionKeyChain: false), );

Future<int> _bumpBadge() async {
  final cur = int.tryParse(await _badgeStore.read(key: _kBadgeKey) ?? '0') ?? 0;
  final next = cur + 1;
  await _badgeStore.write(key: _kBadgeKey, value: '$next');
  try { await AppBadgePlus.updateBadge(next); } catch (_) {}
  return next;
}

Future<void> _clearBadge() async {
  await _badgeStore.write(key: _kBadgeKey, value: '0');
  try { await AppBadgePlus.updateBadge(0); } catch (_) {}
  try { await _local.cancel(8000); } catch (_) {}
}

/// [MULTIACCT-2] Stable per-DEVICE id. The FCM token belongs to the device, not
/// to an account (rulebook: device-level values like the Clerk client token stay
/// global), so this id is stored GLOBALLY (device-level, not account-scoped) and
/// survives log out / switch / re-login. The server keys device_tokens on it and
/// maps accounts to it (account_devices), so a switch flips the mapping instead of
/// orphaning the token — the root fix for the silent-fan-out bug. Generated once.
class DeviceId {
  static const _kKey = 'ava_device_id';
  static String? _cached;
  static const _uuid = Uuid();
  static Future<String> get() async {
    if (_cached != null) return _cached!;
    var v = await DiskCache.readGlobal(_kKey);
    if (v == null || v.isEmpty) {
      v = _uuid.v4();
      await DiskCache.writeGlobal(_kKey, v);
    }
    _cached = v;
    return v;
  }
}

/// CALLFIX-R7: Handle missed-call callback action (Call back button tapped).
/// Reads the stored peerId and routes to dial that peer.
Future<void> _handleMissedCallCallback(String? payload) async {
  final peerId = await DiskCache.read('last_missed_call_peer_id');
  if (peerId != null && peerId.isNotEmpty) {
    Analytics.capture('missed_call_callback_tapped', {'peer_id': peerId});
    _clearBadge();
    navigatorKey.currentState?.popUntil((r) => r.isFirst);
    // TODO: navigate to chat with peerId and trigger dial flow
  }
}

/// A tapped message notification must open the inbox — NOT wherever the app
/// happened to be. (The old build had no tap handler, so a tap just foregrounded
/// the app on whatever screen it was last on — e.g. the Diagnostics page.)
void _onNotifTap(String? payload) {
  if (payload == null) return; // call taps are handled by CallKit, not here
  // Group-invite tap → open the app; the Groups tab + notification bell surface
  // the pending invite (opening the exact thread from a cold tap is a refinement).
  if (payload.startsWith('group')) {
    _clearBadge();
    navigatorKey.currentState?.popUntil((r) => r.isFirst);
    return;
  }
  // [BUSY-CARD-1] Cold-start tap on the now-free banner routes to the redial flow.
  if (payload == 'now_free') {
    _handleNowFreeCallback(payload);
    return;
  }
  // CALLFIX-R7: 'chat' payload opens inbox (main notification tap on missed-call or message).
  // Callback action is handled separately in _handleMissedCallCallback.
  if (payload != 'chat') return;
  _clearBadge();
  navigatorKey.currentState?.popUntil((r) => r.isFirst); // back to shell/chat list
}

/// Local banner for "X added you to <group>" (Phase D — owner request
/// 2026-06-29). Distinct notification id from the message banner so both can show.
Future<void> _showGroupInviteNotif(Map<String, dynamic> d) async {
  final who = (d['fromName'] ?? 'Someone').toString();
  final group = (d['groupName'] ?? 'a group').toString();
  final conv = (d['conv'] ?? '').toString();
  final count = await _bumpBadge();
  await _ensureLocalInit(); // bg isolate: plugin isn't init'd here otherwise → crash
  await _local.show(
    8001,
    'Added to a group',
    '$who added you to $group',
    NotificationDetails(
      android: AndroidNotificationDetails(
        _msgChannel.id, _msgChannel.name,
        channelDescription: _msgChannel.description,
        importance: Importance.high, priority: Priority.high,
        number: count,
        ticker: '$who added you to $group',
        category: AndroidNotificationCategory.social,
      ),
    ),
    payload: conv.isNotEmpty ? 'group:$conv' : 'group',
  );
  await _bgTrack('push_shown', {'channel': 'messages', 'type': 'group_invite'});
}

/// Background/terminated FCM handler — must be a top-level entry point.
@pragma('vm:entry-point')
Future<void> firebaseBackgroundHandler(RemoteMessage message) async {
  final d = message.data;
  final type = (d['type'] ?? '').toString();
  // Record EVERY background push the instant it arrives (durably — the main
  // isolate ships it to PostHog on foreground). This alone makes "did the FCM
  // even reach the device, and of what type" queryable instead of invisible.
  await _bgTrack('fcm_bg_received', {
    'type': type,
    'callId': (d['callId'] ?? '').toString(),
    'keys': d.keys.toList(),
  });
  // Whole-handler guard: a throw in the bg isolate used to look like a hard app
  // crash (and take down any co-processing). Now it's caught + reported, never fatal.
  try {
    if (type == 'message') {
      await _showMessageNotif(d);
    } else if (type == 'group_invite') {
      await _showGroupInviteNotif(d);
    } else if (type == 'del') {
      // Delete-for-everyone — silent. Park it for the app to apply on next foreground.
      await _queuePendingDelete(d);
    } else if (type == 'hide') {
      // Delete-for-me / Undo on another of MY devices — silent. Park it.
      await _queuePendingHide(d);
    } else if (type == 'call_del' || type == 'call_clear') {
      // Call-log delete/clear from another of MY devices — silent wake. The isolate
      // has no AccountScope, so park it for SyncHub.drainPendingCallOps on foreground.
      await _queuePendingCallOp(d);
    } else if (type == 'call-status') {
      // Caller cancelled / call ended before we answered → stop ringing.
      final callId = (d['callId'] ?? '').toString();
      if (callId.isNotEmpty && _terminalCallStatus((d['status'] ?? '').toString())) {
        await FlutterCallkitIncoming.endCall(callId);
      }
    } else if (type == 'now_free' || type == 'call_now_free') {
      // [BUSY-CARD-1] A callee we asked to be notified about is now free →
      // surface the tap-to-call banner even when backgrounded/killed.
      await _showNowFreeNotif(d);
    } else {
      await _showIncoming(d);
    }
    await _bgTrack('fcm_bg_handled', {'type': type});
  } catch (e, st) {
    await _bgTrack('fcm_bg_error', {
      'type': type,
      'error': e.toString(),
      'stack': st.toString().split('\n').take(8).join(' | '),
    });
  }
}

/// Park a delete-for-everyone that arrived while the app was backgrounded/killed.
/// The background isolate has no AccountScope loaded, so it can't write the
/// per-account DeletedStore directly — instead it appends to the GLOBAL
/// (device-level) queue, which [SyncHub.drainPendingDeletes] flushes into the
/// scoped store the instant the app is alive. Silent by design: a redaction must
/// never raise a banner. Entry format mirrors the drain: 'conv\ttarget'.
Future<void> _queuePendingDelete(Map<String, dynamic> d) async {
  final target = (d['target'] ?? '').toString();
  if (target.isEmpty) return;
  final entry = '${(d['conv'] ?? '').toString()}\t$target';
  try {
    final raw = await DiskCache.readGlobal(SyncHub.pendingDeletesKey);
    List<dynamic> list;
    try {
      list = (raw == null || raw.isEmpty) ? <dynamic>[] : (jsonDecode(raw) as List);
    } catch (_) {
      list = <dynamic>[];
    }
    if (!list.contains(entry)) {
      list.add(entry);
      await DiskCache.writeGlobal(SyncHub.pendingDeletesKey, jsonEncode(list));
    }
  } catch (_) {/* best-effort; the next full sync still applies it */}
}

/// Park a delete-for-me / Undo that arrived (silently) from another of MY devices
/// while this one was backgrounded/killed. Same rationale as [_queuePendingDelete]:
/// the background isolate has no AccountScope, so it appends to the GLOBAL queue
/// that [SyncHub.drainPendingHides] flushes into the scoped HiddenStore on the next
/// foreground. Entry format mirrors the drain: 'conv\ttarget\t0|1' (1 = hide).
Future<void> _queuePendingHide(Map<String, dynamic> d) async {
  final target = (d['target'] ?? '').toString();
  if (target.isEmpty) return;
  final hidden = (d['hidden'] ?? '0').toString() == '1' ? '1' : '0';
  final entry = '${(d['conv'] ?? '').toString()}\t$target\t$hidden';
  try {
    final raw = await DiskCache.readGlobal(SyncHub.pendingHidesKey);
    List<dynamic> list;
    try {
      list = (raw == null || raw.isEmpty) ? <dynamic>[] : (jsonDecode(raw) as List);
    } catch (_) {
      list = <dynamic>[];
    }
    // Drop any prior op for the SAME target so the latest hide/undo wins (no stale
    // flip-flop), then append this one.
    list.removeWhere((e) {
      final p = e.toString().split('\t');
      return p.length >= 2 && p[1] == target;
    });
    list.add(entry);
    await DiskCache.writeGlobal(SyncHub.pendingHidesKey, jsonEncode(list));
  } catch (_) {/* best-effort; the next full sync still applies it */}
}

/// Park a call-log delete/clear that arrived (silently) while the app was asleep.
/// Like [_queuePendingDelete], the background isolate can't touch the per-account
/// CallLogStore, so it appends to the GLOBAL queue that
/// [SyncHub.drainPendingCallOps] flushes the instant the app is alive. A 'clear'
/// supersedes any queued per-entry deletes. Entry format: 'del\t<entry_id>' | 'clear'.
Future<void> _queuePendingCallOp(Map<String, dynamic> d) async {
  final isClear = d['type'] == 'call_clear';
  final entryId = (d['entry_id'] ?? '').toString();
  if (!isClear && entryId.isEmpty) return;
  final entry = isClear ? 'clear' : 'del\t$entryId';
  try {
    final raw = await DiskCache.readGlobal(SyncHub.pendingCallOpsKey);
    List<dynamic> list;
    try {
      list = (raw == null || raw.isEmpty) ? <dynamic>[] : (jsonDecode(raw) as List);
    } catch (_) {
      list = <dynamic>[];
    }
    // A clear wipes everything → collapse the queue to just 'clear'.
    if (isClear) {
      list = <dynamic>['clear'];
    } else if (!list.contains(entry) && !list.contains('clear')) {
      list.add(entry);
    }
    await DiskCache.writeGlobal(SyncHub.pendingCallOpsKey, jsonEncode(list));
  } catch (_) {/* best-effort; the next full sync still reconciles */}
}

/// A call-status that means the call is over and any incoming ring should stop.
bool _terminalCallStatus(String s) =>
    s == 'cancel' || s == 'ended' || s == 'missed' || s == 'no-answer';

/// Local notification for a new (E2E) message. Content-less by design — only the
/// sender's display name travels; the message body never leaves the devices.
Future<void> _showMessageNotif(Map<String, dynamic> d) async {
  // Two server push paths carry type=message:
  //  • "notify"      → has fromName (the REAL sender) → this is the user-facing
  //                    banner ("<name> · New message").
  //  • "relay-event" → has event_id but only the EPHEMERAL gift-wrap author
  //                    (E2E hides the real sender), so it can't name anyone. We
  //                    use it purely as a high-priority WAKE so a sleeping phone
  //                    reconnects + syncs fast — no duplicate banner, no bump.
  if (d.containsKey('event_id')) return; // relay-event → wake only
  // Receptionist voicemail ("Ava took a message") is a MISSED-CALL surface, not a
  // chat — route it to the dedicated Calls channel so it reads distinctly and can
  // be tuned/muted apart from chat. The consumer currently delivers it as a plain
  // type=='message' notify (it drops the data.type=='receptionist' tag the
  // reception DO attaches — see the report), so the only client-visible signal is
  // fromName=='Ava' plus an explicit recept/kind flag if the server ever adds one.
  if (_isReceptionistPush(d)) {
    await _showMissedCallNotif(d);
    return;
  }
  final who = (d['fromName'] ?? 'AvaTOK').toString();
  final count = await _bumpBadge();
  // Server-readable arch (owner request 2026-06-27, WhatsApp-style shade): when
  // the push carries a short message PREVIEW, render an EXPANDABLE banner so the
  // user can pull down the shade and read the message without opening AvaTOK.
  // When no preview is present (e.g. legacy/content-less pushes) we fall back to
  // the privacy-safe sender-only banner.
  final preview = (d['preview'] ?? d['body'] ?? '').toString().trim();
  final hasPreview = preview.isNotEmpty;
  final body = hasPreview
      ? preview
      : (count > 1 ? '$count new messages' : 'New message');
  // BigTextStyle = the tap-to-expand long-text layout in the Android shade.
  final styleInfo = hasPreview
      ? BigTextStyleInformation(
          preview,
          contentTitle: who,
          summaryText: count > 1 ? '$count new messages' : null,
        )
      : null;
  await _ensureLocalInit(); // bg isolate: plugin isn't init'd here otherwise → crash
  await _local.show(
    8000, // fixed id → the message notification updates in place (one banner)
    who,
    body,
    NotificationDetails(
      android: AndroidNotificationDetails(
        _msgChannel.id, _msgChannel.name,
        channelDescription: _msgChannel.description,
        importance: Importance.high, priority: Priority.high,
        number: count, // launchers read this for the icon badge count
        ticker: 'Message from $who',
        category: AndroidNotificationCategory.message,
        styleInformation: styleInfo,
      ),
    ),
    payload: 'chat',
  );
  // Reachable from BOTH the bg isolate (firebaseBackgroundHandler) and the
  // foreground path, so use _bgTrack — Analytics isn't available in the bg
  // isolate; _bgTrack durably queues and the main isolate ships it to PostHog.
  await _bgTrack('push_shown', {'channel': 'messages', 'type': 'message'});
}

/// True when a type=='message' push is actually the receptionist's "Ava took a
/// message" voicemail (a missed-call surface). Preferred signal is an explicit
/// server tag (d['recept']=='1' / d['kind']=='receptionist' / d['type']=='receptionist'
/// / d['category']=='missed'); today the consumer strips those, so we fall back to
/// fromName=='Ava', which is what the reception DO sets. See the server-tagging gap
/// noted in the report — once the consumer forwards the tag this stays correct.
bool _isReceptionistPush(Map<String, dynamic> d) {
  final kind = (d['kind'] ?? '').toString().toLowerCase();
  final type = (d['type'] ?? '').toString().toLowerCase();
  final category = (d['category'] ?? '').toString().toLowerCase();
  if (d['recept']?.toString() == '1') return true;
  if (kind == 'receptionist' || type == 'receptionist') return true;
  if (category == 'missed' || type == 'missed') return true;
  // Fallback while the server tag is stripped by the consumer: the reception DO
  // posts the voicemail as fromName='Ava'.
  return (d['fromName'] ?? '').toString() == 'Ava';
}

/// Missed-call / receptionist ("Ava took a message") banner on the dedicated
/// Calls channel. Distinct notification id (8002) from the message banner (8000)
/// so both can coexist. High importance + sound + vibration wakes the screen.
Future<void> _showMissedCallNotif(Map<String, dynamic> d) async {
  final who = (d['callerName'] ?? d['caller_phone'] ?? d['fromName'] ?? 'a caller')
      .toString();
  final preview = (d['preview'] ?? d['body'] ?? '').toString().trim();
  final count = await _bumpBadge();
  final title = 'Missed call — Ava took a message from $who';
  final body = preview.isNotEmpty ? preview : 'Tap to hear the message';
  final styleInfo = preview.isNotEmpty
      ? BigTextStyleInformation(preview, contentTitle: title)
      : null;
  // CALLFIX-21: add "Call back" action button. Extract the caller's peerId from
  // the data (fromPub is the caller's public ID used to dial them back).
  final peerId = (d['fromPub'] ?? '').toString();
  final hasCallbackAction = peerId.isNotEmpty;
  // CALLFIX-R7: Store the peerId so the callback action handler can access it
  if (hasCallbackAction) {
    await DiskCache.write('last_missed_call_peer_id', peerId);
  }
  await _ensureLocalInit(); // bg isolate: plugin isn't init'd here otherwise → crash
  final androidDetails = AndroidNotificationDetails(
    _callsChannel.id, _callsChannel.name,
    channelDescription: _callsChannel.description,
    importance: Importance.high, priority: Priority.high,
    number: count,
    ticker: title,
    category: AndroidNotificationCategory.missedCall,
    styleInformation: styleInfo,
    actions: hasCallbackAction ? [
      AndroidNotificationAction(
        'callback',
        'Call back',
        titleColor: const Color.fromARGB(255, 76, 175, 80),
        cancelNotification: false,
      ),
    ] : [],
  );
  // CALLFIX-R7: Main payload is always 'chat' (to open inbox on tap).
  // The callback action is handled separately via actionId='callback' in onDidReceiveNotificationResponse.
  await _local.show(
    8002, // fixed id → updates in place (one missed-call banner)
    title,
    body,
    NotificationDetails(android: androidDetails),
    payload: 'chat',
  );
  await _bgTrack('push_shown', {'channel': 'calls', 'type': 'missed', 'has_callback': hasCallbackAction});
}

/// [BUSY-CARD-1] "Now free" banner — the callee the caller asked to be notified
/// about (via the busy card's "Notify me") has returned to idle. Deep-links to a
/// redial: tapping the banner (or its "Call" action) stores the callee peer id
/// and routes the same way a missed-call "Call back" does. Server push ASSUMED
/// shape (reconcile with the server agent): {type:'now_free'|'call_now_free',
/// fromPub|callee_uid, fromName|callerName (the callee's display name),
/// generation}. Rendered on the dedicated Calls channel so it reads distinctly.
Future<void> _showNowFreeNotif(Map<String, dynamic> d) async {
  final who = (d['fromName'] ?? d['calleeName'] ?? d['callerName'] ?? 'Your contact')
      .toString();
  // The callee's dial id — same field the missed-call callback uses (fromPub).
  final peerId = (d['fromPub'] ?? d['callee_uid'] ?? '').toString();
  final title = '$who is now free';
  final body = 'Tap to call';
  final count = await _bumpBadge();
  if (peerId.isNotEmpty) {
    // Reuse the existing callback plumbing: the tap handler reads this key.
    await DiskCache.write('last_missed_call_peer_id', peerId);
  }
  await _ensureLocalInit();
  final androidDetails = AndroidNotificationDetails(
    _callsChannel.id, _callsChannel.name,
    channelDescription: _callsChannel.description,
    importance: Importance.high, priority: Priority.high,
    number: count,
    ticker: title,
    category: AndroidNotificationCategory.call,
    actions: peerId.isNotEmpty ? [
      AndroidNotificationAction(
        'now_free_call',
        'Call',
        titleColor: const Color.fromARGB(255, 76, 175, 80),
        cancelNotification: false,
      ),
    ] : [],
  );
  // Payload distinguishes a now-free tap from a plain chat tap so the tap handler
  // can emit now_free_callback_started and route to redial.
  await _local.show(
    8003, // dedicated id so it doesn't overwrite the missed-call banner
    title,
    body,
    NotificationDetails(android: androidDetails),
    payload: 'now_free',
  );
  await _bgTrack('now_free_fcm_shown', {
    'callee_uid': peerId,
    'generation': (d['generation'] ?? '').toString(),
  });
}

/// [BUSY-CARD-1] The now-free banner (or its "Call" action) was tapped → the
/// caller wants to redial the now-free callee. Emits now_free_callback_started
/// and routes to the dial flow, reusing the missed-call callback plumbing.
Future<void> _handleNowFreeCallback(String? payload) async {
  final peerId = await DiskCache.read('last_missed_call_peer_id');
  Analytics.capture('now_free_callback_started', {
    'peer_id': peerId ?? '',
  });
  _clearBadge();
  navigatorKey.currentState?.popUntil((r) => r.isFirst);
  // The redial itself is driven by the chat/dial flow the missed-call callback
  // already routes to (peerId stored above); wiring a cold-start auto-dial is a
  // follow-up, kept identical to _handleMissedCallCallback so behaviour matches.
}

/// Show the native full-screen incoming-call UI (CallKit / ConnectionService),
/// which rings and wakes the screen even when locked or the app is killed.
Future<void> _showIncoming(Map<String, dynamic> d) async {
  if (d['type'] != 'call') { AvaLog.I.log('call', 'incoming skipped (type=${d['type']})'); return; }
  AvaLog.I.log('call', 'showing incoming-call UI callId=${d['callId']} kind=${d['kind']} from=${d['fromName']}');
  IceCache.prefetch(); // warm TURN creds while the phone is still ringing
  final params = CallKitParams(
    id: (d['callId'] ?? '').toString(),
    nameCaller: (d['fromName'] ?? 'AvaTOK').toString(),
    appName: 'AvaTOK',
    handle: (d['fromPub'] ?? '').toString(),
    type: d['kind'] == 'video' ? 1 : 0, // 0 = audio, 1 = video
    duration: 45000,
    textAccept: 'Accept',
    textDecline: 'Decline',
    extra: {
      'from': d['fromPub'] ?? '', // server sends 'fromPub' (FCM reserves 'from')
      'kind': d['kind'] ?? 'audio',
      'callId': d['callId'] ?? '',
      'fromName': d['fromName'] ?? 'AvaTOK',
      // [TRACE-ID-1] Carry the caller's correlation id through CallKit so the
      // callee's CallSession stitches to the same trace as the caller + Worker.
      'trace_id': d['trace_id'] ?? '',
    },
    android: incomingCallAndroidParams,
    ios: const IOSParams(handleType: 'generic', supportsVideo: true),
  );
  await FlutterCallkitIncoming.showCallkitIncoming(params);
}

class PushService {
  // ── Incoming-call de-dup ────────────────────────────────────────────────────
  // FCM can deliver the SAME call push more than once (a retry, or our notify +
  // relay copies), and each copy fired `call_incoming_received` + a CallKit ring.
  // Worse, two accepts opened TWO CallScreens into the same room: the room caps
  // at 2 peers, so the first leg connected P2P while the SECOND was rejected
  // 'busy' and escalated to the AI receptionist — that's why a live call had Ava
  // talking to the caller at the same time (issues 2 & 3). Keyed by callId with a
  // short TTL so a genuine later call (new id) still rings.
  static final Map<String, int> _recentIncoming = {};
  static bool _seenIncoming(String callId) {
    if (callId.isEmpty) return false;
    final now = DateTime.now().millisecondsSinceEpoch;
    _recentIncoming.removeWhere((_, t) => now - t > 60000);
    if (_recentIncoming.containsKey(callId)) return true;
    _recentIncoming[callId] = now;
    return false;
  }

  // Exactly ONE CallScreen per callId. `actionCallAccept` and the cold-start
  // `_recoverAcceptedCall` recovery can both route into the same accepted call,
  // and a duplicate accept event lands twice — each used to push its own
  // CallScreen. Guarded by the on-screen id ([gActiveCallId]) AND a short
  // recently-opened window so the race before initState runs is also covered.
  static String? _openedCallId;
  static int _openedAt = 0;

  // CALLFIX-15: idempotent accept/start handling per call_id. In-memory set of
  // recently-processed call_ids (both accept and start paths). Persisted in
  // DiskCache with last ~20 for recovery after app restart.
  static final Set<String> _processedCallIds = {};
  static const int _maxTrackedIds = 20;
  static const String _pKey = 'processed_call_ids';
  static bool _processedIdsLoaded = false;

  /// Check if a call_id was already processed (accept or start). Returns false
  /// if new, marks it as processed, and returns true on duplicates.
  static Future<bool> _isCallIdProcessed(String callId) async {
    if (callId.isEmpty) return false;
    if (_processedCallIds.contains(callId)) return true;
    // Load persisted list on first use
    if (!_processedIdsLoaded) {
      try {
        final key = scopedKey(_pKey);
        final raw = await DiskCache.read(key);
        if (raw != null && raw.isNotEmpty) {
          final list = (jsonDecode(raw) as List).cast<String>();
          _processedCallIds.addAll(list);
        }
      } catch (_) {/* best-effort */}
      _processedIdsLoaded = true;
    }
    _processedCallIds.add(callId);
    // Trim to last N entries
    if (_processedCallIds.length > _maxTrackedIds) {
      final sorted = _processedCallIds.toList();
      _processedCallIds.clear();
      _processedCallIds.addAll(sorted.skip(sorted.length - _maxTrackedIds));
    }
    // Persist the list
    try {
      final key = scopedKey(_pKey);
      await DiskCache.write(key, jsonEncode(_processedCallIds.toList()));
    } catch (_) {/* best-effort */}
    return false;
  }

  // CALL-GLARE-1: dedupe the accept/decline/missed TELEMETRY bursts. CallKit can
  // deliver actionCallAccept / actionCallDecline / actionCallTimeout more than once
  // for one call (OEM retries, plus the cold-start recovery path), so each of
  // call_incoming_accepted / _declined / _missed fired 2–4× for a single call
  // (PostHog 2026-07-03 18:38). A per-(callId,kind) once-flag with a short TTL keeps
  // exactly one event per outcome per call while a genuine later call (new id) still
  // records. Keyed "<callId>:<accepted|declined|missed>".
  static final Map<String, int> _emittedCallEvents = {};
  static bool _onceCallEvent(String callId, String kind) {
    if (callId.isEmpty) return true; // no id → can't dedupe; let it through once
    final now = DateTime.now().millisecondsSinceEpoch;
    _emittedCallEvents.removeWhere((_, t) => now - t > 120000);
    final key = '$callId:$kind';
    if (_emittedCallEvents.containsKey(key)) return false; // already emitted → skip
    _emittedCallEvents[key] = now;
    return true;
  }

  // CALLFIX-12: Ring capability diagnostics. Track when we last checked so we
  // only emit telemetry once per day (not on every app start). Stored globally
  // (device-level, not per-account) since ring capability is device-wide.
  static int _lastRingCapDiagTime = 0;
  static const int _ringCapDiagIntervalMs = 86400000; // 24 hours

  /// Check ring capabilities (notification permission, calls channel, FSI, DND)
  /// once per day and emit telemetry. Runs on app start (init) and when the app
  /// foregrounds (MainActivity should call this periodically or on resume).
  static Future<void> _checkRingCapabilities() async {
    try {
      final now = DateTime.now().millisecondsSinceEpoch;
      if (now - _lastRingCapDiagTime < _ringCapDiagIntervalMs) return;
      _lastRingCapDiagTime = now;

      // Check if notifications are enabled (Firebase permission already checked in init)
      bool notifEnabled = false;
      try {
        notifEnabled = await _local
                .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
                ?.areNotificationsEnabled() ??
            false;
      } catch (_) {}

      // Check if Calls channel exists and is properly configured
      bool callsChannelOk = false;
      try {
        final androidLocal = _local
            .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
        // If createNotificationChannel succeeded in init(), this is true
        callsChannelOk = _localReady;
      } catch (_) {}

      // Check full-screen intent capability (Android 14+)
      // Note: flutter_local_notifications v17+ has canScheduleExactNotifications()
      // but canUseFullScreenIntent() is NOT exposed in the current version.
      // We can check if the permission is granted via permission_handler, but
      // that's a separate dependency. For now, mark as null and note in report.
      dynamic fsiOk;
      try {
        // Attempt to call if available; if the method doesn't exist, skip it
        final androidLocal = _local
            .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
        // canScheduleExactNotifications is available in flutter_local_notifications ^17
        fsiOk = await androidLocal?.canScheduleExactNotifications() ?? null;
      } catch (_) {
        // Method not available in this version; mark as null
        fsiOk = null;
      }

      // Check DND status (not available in flutter_local_notifications directly;
      // would need MethodChannel into android.app.NotificationManager)
      dynamic dndStatus;
      try {
        // Placeholder: would need platform code to check NotificationManager
        // .isNotificationPolicyAccessGranted() and .getCurrentInterruptionFilter()
        dndStatus = null;
      } catch (_) {}

      Analytics.capture('ring_capability', {
        'notif': notifEnabled,
        'channel_ok': callsChannelOk,
        'fsi_ok': fsiOk,
        'dnd': dndStatus,
      });
    } catch (_) {/* best-effort */}
  }

  /// Ship telemetry the BACKGROUND FCM isolate parked to a device-level queue
  /// (every push it received, every push it handled, and — crucially — any error
  /// it hit) up to PostHog now that we're in the main isolate with Analytics
  /// live. Called on cold start and whenever the app foregrounds. This is what
  /// makes previously-invisible background crashes queryable.
  static Future<void> drainPendingBgTelemetry() async {
    try {
      final raw = await DiskCache.readGlobal(_kPendingBgTelemetry);
      if (raw == null || raw.isEmpty) return;
      final list = (jsonDecode(raw) as List);
      await DiskCache.writeGlobal(_kPendingBgTelemetry, '[]'); // clear before send
      for (final e in list) {
        final m = (e as Map);
        Analytics.capture((m['event'] ?? 'fcm_bg').toString(), {
          ...((m['props'] as Map?)?.cast<String, dynamic>() ?? const {}),
          'bg_ts': m['ts'],
          'source': 'bg_isolate',
        });
      }
    } catch (_) {/* best-effort */}
  }

  /// Completed when [init] finishes (success OR failure) — init now runs
  /// post-first-frame (PERF-1), so consumers that need Firebase messaging ready
  /// (e.g. [registerToken]) wait on this instead of racing a late init.
  static final Completer<void> ready = Completer<void>();
  static void _markReady() { if (!ready.isCompleted) ready.complete(); }

  static Future<void> init() async {
    try {
      await _init();
    } finally {
      _markReady(); // never hang waiters, even when init throws
    }
  }

  static Future<void> _init() async {
    // Desktop (macOS) test build: no APNs and no native incoming-call UI
    // (flutter_callkit_incoming is mobile-only). Skip push/CallKit wiring so the
    // app runs cleanly; messaging still works over the live socket while open.
    if (!Platform.isAndroid && !Platform.isIOS) {
      AvaLog.I.log('app', 'push/CallKit disabled on desktop (${Platform.operatingSystem})');
      return;
    }
    AvaLog.I.log('app', 'session start (app=${AvaLog.I.app}, session=${AvaLog.I.session})');
    final perm = await FirebaseMessaging.instance.requestPermission();
    // Telemetry: a denied/notDetermined notification permission is a common
    // reason a device never receives calls/messages — capture it so "user never
    // got the push" is queryable instead of invisible.
    Analytics.capture('push_permission', {
      'status': perm.authorizationStatus.name, // authorized|denied|notDetermined|provisional
    });
    await _local.initialize(
      const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
      onDidReceiveNotificationResponse: (resp) {
        // CALLFIX-R7: Handle action IDs (e.g., 'callback' on missed-call notification)
        if (resp.actionId == 'callback') {
          _handleMissedCallCallback(resp.payload);
        } else if (resp.actionId == 'now_free_call' || resp.payload == 'now_free') {
          // [BUSY-CARD-1] "Call" action OR a body-tap on the now-free banner.
          _handleNowFreeCallback(resp.payload);
        } else {
          _onNotifTap(resp.payload);
        }
      },
    );
    final androidLocal = _local
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    await androidLocal?.createNotificationChannel(_msgChannel);
    await androidLocal?.createNotificationChannel(_callsChannel);
    _localReady = true; // main isolate is now initialized → _ensureLocalInit no-ops
    // Ship any telemetry the BACKGROUND isolate parked (incl. bg crashes) now that
    // Analytics is live — so background failures stop being invisible.
    await drainPendingBgTelemetry();
    // Cold-started by tapping a message notification? Route to the inbox.
    final launch = await _local.getNotificationAppLaunchDetails();
    if (launch?.didNotificationLaunchApp ?? false) {
      _onNotifTap(launch!.notificationResponse?.payload);
    }
    FirebaseMessaging.onMessage.listen((m) {
      final d = m.data;
      AvaLog.I.log('push', 'FCM received (foreground) type=${d['type']} callId=${d['callId'] ?? ''}');
      Analytics.capture('fcm_fg_received', {
        'type': (d['type'] ?? '').toString(),
        'callId': (d['callId'] ?? '').toString(),
      });
      // Any background pushes that arrived (and any bg crash) just before we came
      // to the foreground get shipped now too.
      drainPendingBgTelemetry();
      // Server-relayed call status → update the active CallScreen.
      if (d['type'] == 'call-status') {
        final callId = (d['callId'] ?? '').toString();
        final status = (d['status'] ?? '').toString();
        // [BUSY-CARD-1] On a BUSY status the server MAY include busy_reason (why),
        // receptionist_enabled (whether "Leave a message for Ava" can show) and an
        // optional pronoun. Present → the caller shows the personalized busy card;
        // absent → plain "User is busy" (unchanged). Only read on status=='busy' so
        // no other status path is affected.
        final busyReason = status == 'busy'
            ? (d['busy_reason']?.toString().trim().isNotEmpty == true
                ? d['busy_reason'].toString()
                : null)
            : null;
        callStatusBus.add((
          callId: callId,
          status: status,
          busyReason: busyReason,
          receptionistEnabled:
              status == 'busy' && (d['receptionist_enabled']?.toString() == '1' ||
                  d['receptionist_enabled'] == true),
          pronoun: status == 'busy'
              ? (d['pronoun']?.toString().trim().isNotEmpty == true
                  ? d['pronoun'].toString()
                  : null)
              : null,
        ));
        // If we're the callee still ringing, dismiss the incoming-call UI.
        if (callId.isNotEmpty && _terminalCallStatus(status)) {
          FlutterCallkitIncoming.endCall(callId);
          // CALLFIX-14: clear glare tracking when the call is no longer ringing
          if (gIncomingRingingCallId == callId) {
            gIncomingRingingFrom = null;
            gIncomingRingingCallId = null;
          }
        }
        return;
      }
      // [BUSY-CARD-1] "Now free" callback — the callee we asked to be notified
      // about (via the busy card's "Notify me") has returned to idle. Surface a
      // tap-to-call banner. Defensive: unknown push kinds must never break the
      // existing handling, so this is a distinct, isolated branch.
      if (d['type'] == 'now_free' || d['type'] == 'call_now_free') {
        Analytics.capture('now_free_fcm_opened', {
          'callee_uid': (d['fromPub'] ?? d['callee_uid'] ?? '').toString(),
          'generation': (d['generation'] ?? '').toString(),
          'state': 'foreground',
        });
        _showNowFreeNotif(d);
        return;
      }
      if (d['type'] == 'message') {
        // Receptionist voicemail arriving while the app is foregrounded: surface
        // the missed-call banner on the Calls channel too (the user may not be on
        // that thread), then still sync so the voicemail thread updates.
        if (_isReceptionistPush(d)) {
          _showMissedCallNotif(d);
          Analytics.capture('push_shown', {'channel': 'calls', 'type': 'missed'});
        }
        // App is open: the live InboxDO socket should already have it. But the
        // socket may be half-open (mobile DNS) and lying. P13-B: the push PROVES
        // there's something new — kick a cursor sync even if the socket looks
        // alive, so the message lands immediately instead of after the zombie
        // watchdog eventually notices.
        SyncHub.I.syncFromPush();
        return;
      }
      if (d['type'] == 'group_invite') {
        // Foreground: show the "added to group" banner + refresh sync so the new
        // group thread appears in the list.
        _showGroupInviteNotif(d);
        SyncHub.I.ensureConnected();
        return;
      }
      if (d['type'] == 'del') {
        // Delete-for-everyone arriving while the app is foregrounded — apply the
        // redaction in realtime (durable tombstone + live thread update).
        final target = (d['target'] ?? '').toString();
        Analytics.capture('chat_delete_push', {
          'delete_id': target, 'state': 'foreground',
        });
        SyncHub.I.applyRemoteDelete(
            target, conv: (d['conv'] ?? '').toString(), source: 'push_fg');
        return;
      }
      if (d['type'] == 'hide') {
        // Delete-for-me / Undo from another of MY devices, app foregrounded → apply
        // the hide/un-hide in realtime (durable HiddenStore + live thread update).
        final target = (d['target'] ?? '').toString();
        final hidden = (d['hidden'] ?? '0').toString() == '1';
        Analytics.capture('chat_hide_push', {
          'target': target, 'hidden': hidden, 'state': 'foreground',
        });
        SyncHub.I.applyRemoteHide(
            target, hidden, conv: (d['conv'] ?? '').toString(), source: 'push_fg');
        return;
      }
      if (d['type'] == 'call_del' || d['type'] == 'call_clear') {
        // Call-log delete/clear from another of MY devices, app foregrounded →
        // apply now (AccountScope is loaded). Also nudge the socket so the next
        // /sync snapshot reconciles anything missed.
        final clear = d['type'] == 'call_clear';
        Analytics.capture('call_log_op_push', {
          'op': clear ? 'clear' : 'del', 'state': 'foreground',
        });
        if (clear) {
          CallLogStore().applyRemoteClear();
        } else {
          CallLogStore().applyRemoteDelete((d['entry_id'] ?? '').toString());
        }
        SyncHub.I.ensureConnected();
        return;
      }
      // Incoming call. Reconcile a possibly-stale "on a call" flag BEFORE
      // deciding to ring or auto-reply busy — a leftover gInCall used to make
      // the device busy-reject every future call (the phantom-busy bug).
      if (d['type'] == 'call') {
        final incomingId = (d['callId'] ?? '').toString();
        final kind = (d['kind'] == 'video') ? 'video' : 'audio';
        // Duplicate/echo push for the call already on screen → ignore.
        if (incomingId.isNotEmpty && incomingId == gActiveCallId) {
          Analytics.capture('call_duplicate_push_ignored', {'call_id': incomingId});
          return;
        }
        // Duplicate push that arrives BEFORE any CallScreen mounts (so the
        // gActiveCallId guard above can't catch it) → drop it. This is what
        // stopped the second CallKit ring + the second accept that opened a
        // parallel call leg and dragged in the receptionist.
        if (_seenIncoming(incomingId)) {
          Analytics.capture('call_duplicate_push_ignored',
              {'call_id': incomingId, 'reason': 'dedup_window'});
          return;
        }
        // CALL-GLARE-1: two users dialing EACH OTHER within ~1s. Our own pending
        // OUTGOING dial makes callIsGenuinelyActive() true, so the peer's crossing
        // incoming push would get auto-busied and the caller heard "busy" though
        // nobody was on a call (PostHog 2026-07-03 18:38:21/22). Detect the glare —
        // an incoming call FROM the exact peer we are currently DIALING (not yet
        // connected) — and resolve it DETERMINISTICALLY instead of busying: the
        // lexicographically SMALLER call_id wins. Both devices compute the same
        // verdict from the same two ids, so exactly one leg survives.
        final glareFrom = (d['from'] ?? '').toString();
        if (glareFrom.isNotEmpty && hasPendingOutgoingTo(glareFrom) &&
            gOutgoingCallId != null && incomingId.isNotEmpty &&
            incomingId != gOutgoingCallId) {
          final incomingWins = incomingId.compareTo(gOutgoingCallId!) < 0;
          Analytics.capture('call_glare_detected', {
            'call_id_in': incomingId,
            'call_id_out': gOutgoingCallId ?? '',
            'resolution': incomingWins ? 'accept_incoming' : 'keep_outgoing',
          });
          if (incomingWins) {
            // Their call wins → cancel OUR outgoing leg and accept theirs. Tell the
            // peer to stop ringing (our cancel), then answer the incoming call.
            final outId = gOutgoingCallId!;
            _signalStatus(outId, 'cancel', (d['fromPub'] ?? '').toString());
            callStatusBus.add((
              callId: outId,
              status: 'glare-yield',
              busyReason: null,
              receptionistEnabled: false,
              pronoun: null,
            ));
            gOutgoingCallTo = null; gOutgoingCallId = null; gOutgoingSince = 0;
            gIncomingRingingFrom = glareFrom;
            gIncomingRingingCallId = incomingId;
            // Show the incoming UI so the accept path (and cold-start recovery) can
            // route into it; the peer keeps its outgoing leg and we connect.
            _showIncoming(d);
          } else {
            // OUR call wins → do NOT busy the incoming; drop this crossing push and
            // keep dialing. The peer's device will yield ITS outgoing and accept
            // ours, so both land in the same room.
            Analytics.capture('call_glare_incoming_dropped',
                {'call_id': incomingId, 'winner': 'outgoing'});
          }
          return;
        }
        // [RECEPT-CALLBACK-PREEMPT-1] Missed-call-then-callback bug: if we are
        // currently leaving a voice message on B's Ava (a live receptionist
        // session — gReceptionistTargetPub == B) and THIS incoming call is
        // FROM B calling us back, do NOT auto-busy it — let it ring and
        // connect instead. A receptionist session makes callIsGenuinelyActive()
        // true (gLiveCallScreens > 0), which is exactly what used to busy the
        // callback before it ever rang. Fail-safe: if the target is unknown or
        // this caller is someone else, fall straight through to the existing
        // autobusy below — unchanged behavior for every other case (including
        // the correct "third caller gets busy while we're on B's Ava" case).
        final receptTarget = gReceptionistTargetPub;
        final callbackFromPub = (d['fromPub'] ?? '').toString();
        if (receptTarget != null &&
            receptTarget.isNotEmpty &&
            callbackFromPub.isNotEmpty &&
            callbackFromPub == receptTarget) {
          Analytics.capture('recept_preempted_by_callback',
              {'call_id': incomingId, 'from': callbackFromPub});
          gIncomingRingingFrom = (d['from'] ?? '').toString();
          gIncomingRingingCallId = incomingId;
          _showIncoming(d);
          return;
        }
        if (callIsGenuinelyActive()) {
          _signalStatus(incomingId, 'busy', (d['fromPub'] ?? '').toString());
          Analytics.capture('call_incoming_autobusy', {
            'call_id': incomingId, 'kind': kind, 'busy_reason': 'on_another_call',
          });
          return;
        }
        if (gInCall) {
          // Stale gInCall — a previous call left it set without tearing down.
          // Clear it so we ring normally instead of silently rejecting busy.
          Analytics.capture('call_stale_incall_cleared', {
            'call_id': incomingId,
            'age_ms': gInCallSince == 0
                ? -1
                : DateTime.now().millisecondsSinceEpoch - gInCallSince,
          });
          gInCall = false;
          gActiveCallId = null;
          gInCallSince = 0;
        }
        Analytics.capture('call_incoming_received', {
          'call_id': incomingId, 'kind': kind, 'state': 'foreground',
        });
        // CALLFIX-14: track the ringing incoming call for glare detection
        gIncomingRingingFrom = (d['from'] ?? '').toString();
        gIncomingRingingCallId = incomingId;
        _showIncoming(d);
        return;
      }
      _showIncoming(d);
    });
    // The FCM token rotates (reinstall, restore, periodic refresh). Always
    // re-register the new one so the device never silently stops receiving
    // calls/pushes — this was a key cause of "no call came through".
    FirebaseMessaging.instance.onTokenRefresh.listen((t) {
      AvaLog.I.log('push', 'FCM token refreshed — re-registering');
      Analytics.capture('push_token_refreshed', {});
      _postToken(t).catchError((e) {
        AvaLog.I.log('push', 're-register failed: $e');
        final err = e.toString();
        Analytics.capture('push_register_failed', {
          'reason': 'refresh_repost_error',
          'error': err.length > 160 ? err.substring(0, 160) : err,
        });
      });
    });
    _listenCallkit();
    await CallDiag.load(); // TURN-only diagnostics flag
    // CALLFIX-12: check ring capabilities once per day
    unawaited(_checkRingCapabilities());
    await _recoverAcceptedCall();
  }

  /// Killed-state accept: when the app was terminated and the user accepted the
  /// native incoming-call UI, the engine cold-starts and the accept event has
  /// already fired before _listenCallkit ran. Check the OS for a call that's
  /// active-but-unanswered-in-Flutter and route into it.
  static Future<void> _recoverAcceptedCall() async {
    try {
      final calls = await FlutterCallkitIncoming.activeCalls();
      if (calls is! List || calls.isEmpty) return;
      for (final c in calls) {
        final m = (c as Map?) ?? const {};
        final accepted = m['isAccepted'] == true || m['accepted'] == true;
        final extra = m['extra'];
        if (accepted && extra is Map && !gInCall) {
          AvaLog.I.log('call', 'recovering accepted call after cold start callId=${extra['callId']}');
          IceCache.prefetch();
          // Give the navigator one frame to exist.
          WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_openCall(extra))); // CALLFIX-15
          return;
        }
      }
    } catch (e) {
      AvaLog.I.log('call', 'activeCalls recovery check failed: $e');
    }
  }

  /// Best-effort: nudge recipients that a new message arrived (content-less).
  static void notifyMessage(List<String> uids, String fromName, {String? preview}) {
    if (uids.isEmpty) return;
    final body = <String, dynamic>{'to': uids, 'fromName': fromName};
    final p = (preview ?? '').trim();
    // Include a short preview so the recipient can read the message from the
    // notification shade (WhatsApp-style). Capped server-side too.
    if (p.isNotEmpty) body['preview'] = p.length > 140 ? p.substring(0, 140) : p;
    ApiAuth.postJson(kNotifyUrl, body).ignore();
  }

  /// Clear the unread app-icon badge + collapse the message notification. Call
  /// when the user opens the app or views the chat list.
  static Future<void> clearMessageBadge() => _clearBadge();

  /// Tell the caller a call was declined / busy — over the WS room (fast path)
  /// AND via the server push (works even if the socket can't be held).
  static void _signalStatus(String callId, String status, String callerNpub) {
    if (callId.isEmpty) return;
    // fast path: signaling room
    try {
      final ch = WebSocketChannel.connect(
          Uri.parse('wss://$kSignalingHost/room/$callId?id=ctl-${DateTime.now().millisecondsSinceEpoch}'));
      ch.sink.add(jsonEncode({'type': status}));
      Future.delayed(const Duration(milliseconds: 800), () {
        try { ch.sink.close(); } catch (_) {}
      });
    } catch (_) {/* best effort */}
    // durable path: server pushes the status to the caller
    if (callerNpub.isNotEmpty) {
      ApiAuth.postJson(kCallStatusUrl, {'to': callerNpub, 'callId': callId, 'status': status}).ignore();
    }
  }

  /// React to taps on the native call UI (accept / decline / timeout).
  static void _listenCallkit() {
    FlutterCallkitIncoming.onEvent.listen((event) {
      if (event == null) return;
      switch (event.event) {
        case Event.actionCallAccept:
          IceCache.prefetch(); // accept tapped → call screen is next; warm TURN now
          final acc = event.body['extra'];
          if (acc is Map) {
            final accId = (acc['callId'] ?? '').toString();
            // CALL-GLARE-1: dedupe duplicate accept events for the same call.
            if (_onceCallEvent(accId, 'accepted')) {
              Analytics.capture('call_incoming_accepted', {
                'call_id': accId,
                'kind': acc['kind'] == 'video' ? 'video' : 'audio',
              });
            }
          }
          // CALLFIX-R6: Clear glare state when accept is tapped
          gIncomingRingingFrom = null;
          gIncomingRingingCallId = null;
          unawaited(_openCall(event.body['extra'])); // CALLFIX-15
          break;
        case Event.actionCallDecline:
          final extra = event.body['extra'];
          if (extra is Map) {
            // v2 Mode C: if the owner enabled "let Ava take calls I decline",
            // signal 'decline_ava' so the caller hands off to the receptionist
            // instead of getting a plain decline. Else signal a normal decline.
            // ignore: unawaited_futures
            _declineRouting(extra);
          }
          // CALLFIX-R6: Clear glare state when decline is tapped
          gIncomingRingingFrom = null;
          gIncomingRingingCallId = null;
          break;
        case Event.actionCallTimeout:
          final ex = event.body['extra'];
          if (ex is Map) _logMissed(ex);
          break;
        case Event.actionCallEnded:
          break;
        default:
          break;
      }
    });
  }

  /// Decline routing (v2 Mode C). Audio calls only — Ava is audio. Reads the
  /// per-account local mirror written by the Settings card (DiskCache keys
  /// receptionist_enabled + receptionist_decline_to_ava) so it works even when
  /// the app was woken cold for the call.
  static Future<void> _declineRouting(Map extra) async {
    final callId = (extra['callId'] ?? '').toString();
    final from = (extra['from'] ?? '').toString();
    var status = 'decline';
    try {
      final isAudio = extra['kind'] != 'video';
      if (isAudio) {
        // Owner decision 2026-06-25: when Ava is enabled, an explicit Decline
        // should ALSO hand the caller to the receptionist to take a message.
        // This was gated behind a separate decline_to_ava sub-toggle that was
        // off by default, so Reject → dead end instead of "Ava takes a message".
        // Enabling Ava is now sufficient (the caller still falls back to a plain
        // decline if Ava can't actually pick up).
        final enabled = (await DiskCache.read('receptionist_enabled')) == '1';
        if (enabled) status = 'decline_ava';
      }
    } catch (_) {/* fall back to plain decline */}
    _signalStatus(callId, status, from);
    // CALL-GLARE-1: dedupe duplicate decline events for the same call.
    if (_onceCallEvent(callId, 'declined')) {
      Analytics.capture('call_incoming_declined', {
        'call_id': callId,
        'routed_to': status, // 'decline' | 'decline_ava'
      });
    }
    _logMissed(extra);
  }

  static void _logMissed(Map extra) {
    final missedId = (extra['callId'] ?? '').toString();
    // CALL-GLARE-1: dedupe duplicate missed events for the same call (a decline
    // routes here too, and CallKit can fire timeout more than once).
    if (_onceCallEvent(missedId, 'missed')) {
      Analytics.capture('call_incoming_missed', {
        'call_id': missedId,
        'kind': extra['kind'] == 'video' ? 'video' : 'audio',
      });
    }
    CallLogStore().add(CallEntry(
      name: (extra['fromName'] ?? 'Caller').toString(),
      seed: (extra['from'] ?? 'caller').toString(),
      video: extra['kind'] == 'video',
      dir: CallDir.missed,
      ts: DateTime.now().millisecondsSinceEpoch ~/ 1000,
    ));
  }

  /// Register this device's FCM token against the user's uid.
  static Future<void> registerToken(String uid) async {
    // init() is deferred to post-first-frame (PERF-1): wait for it (bounded)
    // so getToken() isn't called before Firebase messaging is set up.
    try { await ready.future.timeout(const Duration(seconds: 15)); } catch (_) {}
    try {
      var token = await FirebaseMessaging.instance.getToken();
      if (token == null) {
        AvaLog.I.log('push', 'FCM token null — retrying in 3s');
        await Future.delayed(const Duration(seconds: 3));
        token = await FirebaseMessaging.instance.getToken();
      }
      if (token == null) {
        AvaLog.I.log('push', 'FCM token STILL NULL — device cannot receive calls/pushes');
        // Telemetry: a null FCM token means /api/register is never reached, so the
        // server stores 0 push tokens and CALLERS hit the "no device registered"
        // 404. Previously this was only in the local diag log (invisible in
        // PostHog) — emit a discrete, per-user event so it is queryable.
        Analytics.capture('push_register_failed', {'reason': 'fcm_token_null'});
        return;
      }
      await _postToken(token);
    } catch (e) {
      AvaLog.I.log('push', 'register token FAILED: $e');
      // Surface the FCM/Firebase error (e.g. FIS_AUTH_ERROR — a Firebase
      // Installations auth failure) as its own event so the root cause behind
      // "no device registered" is visible per-user in PostHog.
      final err = e.toString();
      Analytics.capture('push_register_failed', {
        'reason': 'exception',
        'error': err.length > 200 ? err.substring(0, 200) : err,
      });
    }
  }

  /// [MULTIACCT-2] Flip the ACTIVE account's mapping on this device without
  /// touching the shared device token. `active:false` on logout / switch-OUT so
  /// the departing account stops resolving to this device's token; `active:true`
  /// (the default, also implied by a fresh registerToken) on switch-IN. The token
  /// row is device-owned and untouched, so the next account reuses it. Best-effort
  /// — a switch must never block on this network call. NOTE: uid is derived
  /// server-side from the auth signature, so this MUST be called while the target
  /// account's auth is active (registerToken for switch-IN; before signing the
  /// departing session out for switch-OUT).
  static Future<void> mapDevice({required bool active}) async {
    try {
      final deviceId = await DeviceId.get();
      await ApiAuth.postJson(kAccountDeviceUrl, {'device_id': deviceId, 'active': active});
      Analytics.capture('account_device_mapped', {'active': active});
    } catch (e) {
      AvaLog.I.log('push', 'mapDevice(active=$active) failed: $e');
    }
  }

  /// POST the current token to the server (uid is derived server-side from the
  /// NIP-98 signature). Used by registerToken AND by onTokenRefresh.
  static Future<void> _postToken(String token) async {
    // [MULTIACCT-2] Send the stable per-device id so the server keys the token by
    // DEVICE (device_tokens) and maps the ACTIVE account to it (account_devices).
    // A token refresh updates the single device row; a login/switch flips the
    // mapping — neither orphans the token, so the callee never becomes silently
    // unreachable after a re-login.
    final deviceId = await DeviceId.get();
    final res = await ApiAuth.postJson(
        kRegisterUrl, {'token': token, 'platform': 'fcm', 'device_id': deviceId});
    AvaLog.I.log('push', 'registered FCM token ${token.substring(0, 10)}… -> HTTP ${res.statusCode}');
    // Telemetry: distinguish a real registration (HTTP 200) from a server-side
    // failure (401/5xx). A non-200 here also means the device ends up with no
    // usable token row, so don't log it as "ok" — that masked the problem before.
    final ok = res.statusCode == 200;
    Analytics.capture(ok ? 'push_register_ok' : 'push_register_failed', {
      'reason': ok ? 'registered' : 'http_error',
      'status': res.statusCode,
    });
    // Additional, explicit "token registered" event (kept ALONGSIDE
    // push_register_ok, not replacing it) so a successful FCM-token registration
    // is queryable under a stable name for the FIX-FCM tracking dashboard.
    if (ok) {
      Analytics.capture('push_token_registered', {
        'platform': 'fcm',
        'status': res.statusCode,
      });
    }
  }

  /// CALLFIX-14 (glare): programmatically answer the currently-ringing incoming
  /// call — used when the user taps Call while the same peer is already ringing
  /// in. Dismisses the CallKit ring UI and opens the call like a normal accept.
  static Future<void> acceptRingingCall(String callId) async {
    try {
      final calls = await FlutterCallkitIncoming.activeCalls();
      if (calls is List) {
        for (final c in calls) {
          if (c is Map && (c['id'] ?? '').toString() == callId) {
            try { await FlutterCallkitIncoming.endCall(callId); } catch (_) {}
            await _openCall(c['extra']);
            return;
          }
        }
      }
    } catch (_) {/* best-effort — worst case the incoming ring keeps ringing */}
  }

  static Future<void> _openCall(dynamic extra) async {
    try {
      final e = (extra as Map);
      final room = (e['callId'] ?? '').toString();
      if (room.isEmpty) return;
      // [CALL-DUP-SESSION-2] SYNCHRONOUS reservation BEFORE any await. This is the
      // last duplicate-session construction leak: on a CallKit accept while the app
      // is backgrounded, the first accept pushed a CallScreen route whose initState
      // (→ manager.attach() → the _byRoom registry) does NOT run until the widget is
      // built, which is deferred while backgrounded. Meanwhile a second accept path
      // fires — the OS re-delivering actionCallAccept on FGS bring-to-front, or the
      // resume-time _recoverAcceptedCall — and reaches _openCall again. The existing
      // guards below (managerHasLive / gActiveCallId) all read state that is only
      // set AFTER initState runs, so during that window they see nothing and let a
      // SECOND CallScreen through → a 3rd peer → 2-peer-cap busy → the busy handler
      // kills the live call (PostHog avatok-3a2d4f15, 2026-07-05). Even the CALLFIX-15
      // idempotency gate leaked here: its first-ever call awaits a DiskCache load
      // before recording the id, so two concurrent _openCall calls both pass it.
      // Fix: claim the room in a plain in-memory field with NO await between the
      // check and the set, so the second concurrent open is rejected deterministically
      // regardless of how the route/registry state has (not) settled yet.
      final nowSync = DateTime.now().millisecondsSinceEpoch;
      if (room == _openedCallId && nowSync - _openedAt < 60000) {
        Analytics.capture('call_dup_session_blocked', {
          'call_id': room,
          'via': 'open_call_reserve',
        });
        return;
      }
      _openedCallId = room;
      _openedAt = nowSync;
      // CALLFIX-15: idempotent accept handling. Each call_id processed exactly once.
      if (await _isCallIdProcessed(room)) {
        Analytics.capture('call_duplicate_open_ignored', {
          'call_id': room,
          'reason': 'already_processed',
        });
        return;
      }
      // One CallScreen per callId. If one is already on screen, or we opened this
      // same call moments ago (duplicate accept / cold-start recovery race),
      // don't push a second one — a second leg joins the room, gets 'busy', and
      // hands the caller to Ava mid-call (issues 2 & 3).
      final now = DateTime.now().millisecondsSinceEpoch;
      // [CALL-DUP-SESSION-1] Defense in depth: also consult the CallSession
      // manager's live-session registry, not just the `gActiveCallId` global
      // (which is set only AFTER the pushed CallScreen's initState → start()
      // runs, leaving a window a second accept/restore can slip through). If a
      // live session already owns this room, just foreground/re-attach the
      // existing call screen instead of pushing a SECOND CallScreen (whose
      // attach() would dedup anyway, but pushing a duplicate route is wasteful
      // and briefly double-stacks the UI).
      final managerHasLive = CallSessionManager.instance.hasLiveSession(room);
      if (managerHasLive) {
        Analytics.capture('call_duplicate_open_ignored', {
          'call_id': room,
          'reason': 'manager_live_session',
        });
        // Re-present the existing call screen if it was minimized.
        try { returnToActiveCall(); } catch (_) {}
        return;
      }
      // [CALL-DUP-SESSION-2] The (_openedCallId, _openedAt) reservation is now
      // claimed SYNCHRONOUSLY at the top of _openCall (before any await), so it is
      // no longer re-checked or re-set here — doing so would always self-trip since
      // we already set _openedCallId = room above. The remaining guard is the
      // on-screen id, which catches a session that has already mounted its route.
      if (gActiveCallId == room) {
        Analytics.capture('call_duplicate_open_ignored', {
          'call_id': room,
          'reason': 'race_condition',
        });
        return;
      }
      // [CALL-EXCL-1] Single audio authority: BEFORE opening the accepted call,
      // make it the ONLY audio-owning session on this device — gracefully yield
      // any live receptionist (Ava) session (no voicemail/ack) and cleanly bye
      // any other live call leg. This is the acceptance path's single authority
      // point (delegated to the CallSessionManager).
      try { await CallSessionManager.instance.prepareForAccept(room); } catch (_) {}
      navigatorKey.currentState?.push(MaterialPageRoute(
        builder: (_) => CallScreen(
          room: (e['callId'] ?? '').toString(),
          title: (e['fromName'] ?? 'Caller').toString(),
          seed: (e['from'] ?? 'caller').toString(),
          video: e['kind'] == 'video',
          outgoing: false,
          traceId: (e['trace_id'] ?? '').toString(), // [TRACE-ID-1]
        ),
      ));
    } catch (_) {}
  }
}
