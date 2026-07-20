import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/account_storage.dart';
import '../core/active_thread.dart'; // [PUSH-FG-BANNER-1]
import '../core/analytics.dart';
import '../core/api_auth.dart';
import '../core/ava_log.dart';
import '../core/badge_service.dart';
import '../core/call_log_store.dart';
import '../core/calls/call_overlay.dart' show returnToActiveCall;
import '../core/calls/call_room_id.dart' show CallRoomId; // [CALL-DEDUP-TTL-1]
import '../core/calls/callkit_params.dart' show incomingCallAndroidParams;
import '../core/calls/call_session_manager.dart';
import '../core/calls/call_telemetry_events.dart' show CallEvents;
import '../core/config.dart';
import '../core/disk_cache.dart';
import '../core/ice_cache.dart';
import '../core/onboarding_store.dart';
import '../core/remote_config.dart';
import '../core/voice/native_voice_audio.dart';
import '../features/avadial/contact_overrides.dart' show ContactOverrides;
import '../features/avadial/device_contacts.dart' show DeviceContacts;
import '../features/avatok/call_screen.dart';
import '../features/avatok/contacts.dart' show ContactsStore;
import '../features/avatok/incoming_business_call_screen.dart';
import '../identity/identity.dart' show AccountScope; // [AVANOTIF-VM-3] name-cache account namespacing
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

/// [CALL-RING-OBS-1] Isolate-agnostic capture.
///
/// `_showIncoming` is reached from BOTH the main isolate (WS ring, foreground
/// FCM) and the FCM background isolate. `Analytics.capture` is a no-op-ish in
/// the bg isolate (no PostHog client, no account scope), and `_bgTrack` in the
/// main isolate would delay the event until the next foreground drain. Route to
/// whichever is honest for the isolate we're actually on, so ring telemetry is
/// never silently lost — which is exactly why "was the incoming screen shown?"
/// was unanswerable during the 2026-07-14 missed-incoming-screen incident.
/// NOTE: `Map<String, Object>`, not `Map<String, dynamic>` — [Analytics.capture]
/// takes `Map<String, Object>?`, so a null VALUE here would blow up on the
/// implicit generic downcast at runtime. Callers must use a sentinel
/// ('unknown', -1) or a conditional entry rather than a null.
Future<void> _track(String event, Map<String, Object> props) async {
  if (BadgeService.inBackgroundIsolate) {
    await _bgTrack(event, props);
    return;
  }
  try {
    await Analytics.capture(event, props);
  } catch (_) {/* telemetry must never break the ring path */}
}

// --- Unread app-icon badge (red dot + count, WhatsApp-style) ----------------
// [ISSUE-BADGE-UNREAD-1] The badge is owned END-TO-END by [BadgeService] now.
// This file used to hold the whole thing, and it was a PUSH COUNTER: +1 per
// banner, never decremented per-read, only ever reset to 0 by a tap that reached
// the chat list — which under ShellV2 often never mounts. Hence the owner's
// stuck number with an empty inbox. The badge is now derived from real unread
// state (chat DB + read-state, plus AvaDialer SMS); these two shims stay only so
// the call sites below read unchanged.
//
// `_bumpBadge` is the value the BANNER prints in `number:`; the authoritative
// reconcile is scheduled by BadgeService.bump (foreground) or deferred to the
// next foreground recompute (background isolate).
Future<int> _bumpBadge([String source = 'push']) => BadgeService.bump(source);

/// Reconcile the badge against reality. NOT a blind clear: if messages really
/// are unread the badge must survive opening the app and show the true count.
Future<void> _clearBadge([String source = 'notif_tap']) =>
    BadgeService.recompute(source: source);

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
  // [AVANOTIF-VM-1] GLOBAL, not scoped — see the write site in
  // _showMissedCallNotif for why (the bg isolate has no AccountScope).
  final peerId = await DiskCache.readGlobal('last_missed_call_peer_id');
  if (peerId != null && peerId.isNotEmpty) {
    Analytics.capture('missed_call_callback_tapped', {'peer_id': peerId});
    _clearBadge('missed_call_callback_tap');
    navigatorKey.currentState?.popUntil((r) => r.isFirst);
    // TODO: navigate to chat with peerId and trigger dial flow
  }
}

/// A tapped message notification must open the inbox — NOT wherever the app
/// happened to be. (The old build had no tap handler, so a tap just foregrounded
/// the app on whatever screen it was last on — e.g. the Diagnostics page.)
void _onNotifTap(String? payload) {
  if (payload == null) return; // call taps are handled by CallKit, not here
  // [AVANOTIF-VM-1] Notification-tap telemetry — always fires on the main
  // isolate (a tap resumes/launches the app), so a plain Analytics.capture is
  // safe here (no bg-isolate routing needed, unlike _track elsewhere in this file).
  Analytics.capture('push_notif_tapped', {'payload_kind': payload});
  // Group-invite tap → open the app; the Groups tab + notification bell surface
  // the pending invite (opening the exact thread from a cold tap is a refinement).
  if (payload.startsWith('group')) {
    _clearBadge('group_notif_tap');
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
  _clearBadge('chat_notif_tap');
  navigatorKey.currentState?.popUntil((r) => r.isFirst); // back to shell/chat list
}

/// Local banner for "X added you to <group>" (Phase D — owner request
/// 2026-06-29). Distinct notification id from the message banner so both can show.
Future<void> _showGroupInviteNotif(Map<String, dynamic> d) async {
  final who = (d['fromName'] ?? 'Someone').toString();
  final group = (d['groupName'] ?? 'a group').toString();
  final conv = (d['conv'] ?? '').toString();
  final count = await _bumpBadge('group_invite');
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
Future<void> firebaseBackgroundHandler(RemoteMessage message) =>
    // [ISSUE-BADGE-UNREAD-1] Mark the isolate FOR THE DURATION OF THIS HANDLER
    // ONLY: it has no app state, no AccountScope and no open drift DB, so the
    // badge cannot be recomputed from real unread state here. BadgeService falls
    // back to a provisional +1 and the next foreground recompute (app resume /
    // chat list / thread marked read) corrects it.
    //
    // This was a one-way latch (`inBackgroundIsolate = true`, never reset). If
    // this top-level entry point ever ran on the MAIN isolate, every subsequent
    // recompute short-circuited to the last persisted value and the badge froze
    // for the process lifetime — the very bug we're fixing. runInBackgroundIsolate
    // clears the flag in a `finally`, throw or not.
    BadgeService.runInBackgroundIsolate(() => _handleBackgroundMessage(message));

Future<void> _handleBackgroundMessage(RemoteMessage message) async {
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
        // [AVACALL-CANCEL-1] Record BEFORE we (async) end the CallKit ring, so an
        // accept that races the cancel still finds the terminal marker.
        _noteTerminalCall(callId);
        await FlutterCallkitIncoming.endCall(callId);
      }
    } else if (type == 'now_free' || type == 'call_now_free') {
      // [BUSY-CARD-1] A callee we asked to be notified about is now free →
      // surface the tap-to-call banner even when backgrounded/killed.
      await _showNowFreeNotif(d);
    } else {
      if (type == 'call') {
        final callId = (d['callId'] ?? '').toString();
        final token = (d['ringReceiptToken'] ?? '').toString();
        if (callId.isNotEmpty && token.isNotEmpty) {
          // ignore: unawaited_futures
          PushService.reportRinging(callId, token);
        }
      }
      await _showIncoming(d, route: 'fcm_bg');
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
    s == 'cancel' || s == 'ended' || s == 'missed' || s == 'no-answer' ||
    s == 'bye';

/// [AVACALL-CANCEL-1] Last-terminal-status cache keyed by callId. The
/// `callStatusBus` is a plain broadcast Stream with NO replay, so a cancel/bye/
/// ended that lands BEFORE a just-accepted call's CallSession attaches its
/// listener is lost — the callee then paints "connecting" for a caller who is
/// already gone (2026-07-20 incident: ring push arrived 2s AFTER the cancel).
/// Every terminal call-status the device sees (FCM bg/fg or WS) is recorded here
/// with a timestamp; CallSession.start() drains it on the accept path so a
/// pre-subscription cancel is honored. Short TTL — this only needs to bridge the
/// accept window, never leak into a later, legitimately re-used callId.
final Map<String, int> _terminalCallAt = <String, int>{};
const int _kTerminalCallTtlMs = 90 * 1000;

void _noteTerminalCall(String callId) {
  if (callId.isEmpty) return;
  final now = DateTime.now().millisecondsSinceEpoch;
  _terminalCallAt[callId] = now;
  // Opportunistic prune so the map can't grow unbounded across a long session.
  if (_terminalCallAt.length > 64) {
    _terminalCallAt.removeWhere((_, ts) => now - ts > _kTerminalCallTtlMs);
  }
}

// ── [AVANOTIF-VM-1] Recipient-side contact-name resolution for push banners ──
//
// The push payload's `fromName` is the SENDER's own self-declared display name
// (see chat_thread.dart's `_myName`, falling back to Identity.shortId when the
// sender never set a profile name), sent FROM the sender's device. It is never
// checked against the RECIPIENT's own contact book, so a caller with no profile
// name — or one the recipient has renamed/overridden locally — showed up as a
// raw phone number / uid fragment in the shade (owner report 2026-07-16:
// "919820436843" / "New message"). The fix resolves the name HERE, on the
// recipient's device, from the recipient's OWN contacts — the way a normal
// phone dialer would.
//
// [BG-ISOLATE-1] The FCM BACKGROUND isolate (`firebaseBackgroundHandler`) has no
// `AccountScope`, no live Clerk session and no guarantee any plugin beyond what
// firebase_messaging itself registers is safe to call. `AccountScope.id` is an
// in-memory static that is simply UNSET in a fresh isolate — so a normal scoped
// `DiskCache.read`/`ContactsStore().load()` would silently resolve to the WRONG
// ("default") on-disk folder instead of throwing, which would have made this
// fix look like it worked while quietly resolving nothing. Rather than fake
// scoping in the bg isolate, the MAIN isolate periodically flattens all three
// name sources (contact overrides, the AvaTOK contact book, the device phone
// book) into one small GLOBAL (device-level) JSON file, namespaced internally by
// account id, that the bg isolate reads with a plain `DiskCache.readGlobal` —
// no plugin channel, no `AccountScope` required. Priority is baked in at WRITE
// time: device phone book < AvaTOK contacts < contact-override rename (see
// [_rebuildNameCache]). This was verified against the existing, already-shipped
// `_bgTrack`/`_queuePendingDelete` pattern, which proves `DiskCache.readGlobal`
// (path_provider under the hood) already works from this isolate; the SCOPED
// variant does not, for the `AccountScope.id`-unset reason above — that is
// exactly why those existing helpers use `readGlobal`, never `read`.
const String _kNameCacheKey = 'push_name_cache_v1';
// Mirrors main.dart's private `_kAcct` constant — the GLOBAL key it already
// persists the signed-in Clerk account id under (for local-first boot). Kept as
// a literal here (main.dart's constant is private) — the two must never diverge.
const String _kActiveAccountKey = 'clerk_account_id';

/// Rebuild the flat, background-isolate-readable name cache from the recipient's
/// OWN contact sources. MAIN ISOLATE ONLY (guarded) — the bg isolate has none of
/// these stores loaded correctly (see [BG-ISOLATE-1] above), so calling this
/// there would just persist an empty/wrong cache over a good one.
Future<void> _rebuildNameCache() async {
  if (BadgeService.inBackgroundIsolate) return;
  try {
    final acctId = AccountScope.id;
    if (acctId == null || acctId.isEmpty) return; // no account yet — nothing to cache
    final byUid = <String, String>{};
    final byPhone = <String, Map<String, String>>{}; // normKey -> {name, tier}

    // Lowest priority first — later writers below overwrite on key collision.
    try {
      final permStatus = await Permission.contacts.status; // READ-ONLY — never prompts
      if (permStatus.isGranted) {
        final device = await DeviceContacts.I.load(); // cached in-memory if already loaded
        for (final c in device) {
          final name = (c.name ?? '').trim();
          if (name.isEmpty) continue;
          final key = DeviceContacts.normKey(c.number);
          if (key.isEmpty) continue;
          byPhone[key] = {'name': name, 'tier': 'device_contact'};
        }
      }
    } catch (_) {/* best-effort — lowest-priority tier anyway */}

    try {
      final contacts = await ContactsStore().load();
      for (final c in contacts) {
        if (c.name.trim().isEmpty) continue;
        if (c.uid.isNotEmpty && !c.isPhoneOnly) byUid[c.uid] = c.name;
        final phoneLike = c.phone.isNotEmpty ? c.phone : c.number;
        if (phoneLike.isNotEmpty) {
          final key = DeviceContacts.normKey(phoneLike);
          if (key.isNotEmpty) byPhone[key] = {'name': c.name, 'tier': 'contact'};
        }
      }
    } catch (_) {/* best-effort */}

    try {
      final overrides = await ContactOverrides.I.load();
      for (final o in overrides) {
        final name = (o.displayName ?? '').trim();
        if (name.isEmpty || o.hidden) continue;
        final key = DeviceContacts.normKey(o.number);
        if (key.isEmpty) continue;
        byPhone[key] = {'name': name, 'tier': 'override'}; // highest priority — always wins
      }
    } catch (_) {/* best-effort */}

    final raw = await DiskCache.readGlobal(_kNameCacheKey);
    Map<String, dynamic> all = {};
    if (raw != null && raw.isNotEmpty) {
      try { all = jsonDecode(raw) as Map<String, dynamic>; } catch (_) {/* start fresh */}
    }
    all[acctId] = {'uid': byUid, 'phone': byPhone};
    await DiskCache.writeGlobal(_kNameCacheKey, jsonEncode(all));
  } catch (_) {/* best-effort — a failed rebuild just leaves the last-good cache in place */}
}

/// Resolve a display name + which fallback TIER won (for telemetry — proves in
/// PostHog which stage of the chain is actually firing in prod). Safe to call
/// from EITHER isolate: reads only via `DiskCache.readGlobal`, no `AccountScope`,
/// no plugin channel.
///
/// Priority: (1) recipient's own contact-override rename, by phone/number →
/// (2) recipient's AvaTOK contact match, by uid then phone/number →
/// (3) recipient's device phone book, by phone/number →
/// [(1)-(3) all live inside the flattened cache — see [_rebuildNameCache]] →
/// (4) the payload's own `fromPhone`, formatted → (5) the payload's `fromName` →
/// (6) [unknownFallback].
Future<({String name, String tier})> _resolveDisplayName({
  String? fromUid,
  String? fromPhone,
  String? fromName,
  String unknownFallback = 'Unknown caller',
}) async {
  try {
    final acctId = await DiskCache.readGlobal(_kActiveAccountKey);
    if (acctId != null && acctId.isNotEmpty) {
      final raw = await DiskCache.readGlobal(_kNameCacheKey);
      if (raw != null && raw.isNotEmpty) {
        final all = jsonDecode(raw) as Map<String, dynamic>;
        final mine = all[acctId] as Map<String, dynamic>?;
        if (mine != null) {
          if (fromPhone != null && fromPhone.isNotEmpty) {
            final key = DeviceContacts.normKey(fromPhone);
            final byPhone = (mine['phone'] as Map?)?.cast<String, dynamic>();
            final hit = byPhone?[key];
            if (hit is Map) {
              final name = (hit['name'] ?? '').toString();
              if (name.isNotEmpty) {
                return (name: name, tier: (hit['tier'] ?? 'contact').toString());
              }
            }
          }
          if (fromUid != null && fromUid.isNotEmpty) {
            final byUid = (mine['uid'] as Map?)?.cast<String, dynamic>();
            final name = (byUid?[fromUid] ?? '').toString();
            if (name.isNotEmpty) return (name: name, tier: 'contact_uid');
          }
        }
      }
    }
  } catch (_) {/* fall through to the payload/formatted fallbacks below */}
  // No local match. A raw phone is more useful FORMATTED than a sender's own
  // fromName when one is available — for PSTN/receptionist pushes, fromName is
  // often just the same raw number as a label, not a chosen human name.
  if (fromPhone != null && fromPhone.trim().isNotEmpty) {
    return (name: _formatPhoneDisplay(fromPhone), tier: 'formatted_phone');
  }
  final fn = (fromName ?? '').trim();
  if (fn.isNotEmpty) return (name: fn, tier: 'from_name');
  return (name: unknownFallback, tier: 'unknown');
}

/// Best-effort E.164-ish pretty-printer: '919820436843' -> '+91 98204 36843'.
/// Not full libphonenumber formatting — just enough that an unresolved caller
/// reads as a phone number, not a digit dump (owner report 2026-07-16).
String _formatPhoneDisplay(String raw) {
  final trimmed = raw.trim();
  if (trimmed.isEmpty) return 'Unknown number';
  final digits = trimmed.replaceAll(RegExp(r'[^0-9]'), '');
  if (digits.isEmpty) return trimmed; // alphanumeric sender id (e.g. 'VM-HDFCBK') — show as-is
  if (digits.length <= 6) return '+$digits';
  var cc = '';
  var rest = digits;
  if (digits.length > 10) {
    cc = digits.substring(0, digits.length - 10);
    rest = digits.substring(digits.length - 10);
  }
  final g1 = rest.length > 5 ? rest.substring(0, rest.length - 5) : rest;
  final g2 = rest.length > 5 ? rest.substring(rest.length - 5) : '';
  final parts = [if (cc.isNotEmpty) cc, g1, if (g2.isNotEmpty) g2];
  return '+${parts.join(' ')}';
}

// ── [AVANOTIF-VM-1] Missed-call per-caller grouping ─────────────────────────
// Notification id 8002 used to be reused verbatim for EVERY missed caller, so a
// second missed call (from anyone) silently overwrote the first caller's banner
// in place rather than the two coexisting — the opposite of a proper per-caller
// group. Each caller now gets a STABLE id derived from their phone/uid, tagged
// with a shared `groupKey`, plus a summary notification (kept on the original
// 8002 id for continuity) that Android collapses the group under.
const String _kMissedCallsGroupKey = 'avatok_calls_missed';
const int _kMissedCallsSummaryId = 8002;
const String _kMissedCallsLogKey = 'push_missed_calls_log_v1'; // GLOBAL, keyed by account id

int _missedCallNotifId(String key) {
  if (key.isEmpty) return 8010;
  // 8100..8899 — clear of the other fixed ids (8000-8003).
  return 8100 + (key.hashCode.abs() % 800);
}

/// Append one missed-call line to the (capped) per-account log and (re)post the
/// group summary notification. Best-effort — grouping is cosmetic; a failure
/// here never prevents the per-caller banner itself from showing.
Future<void> _updateMissedCallsSummary(String line) async {
  try {
    var acctId = AccountScope.id ?? '';
    if (acctId.isEmpty) acctId = (await DiskCache.readGlobal(_kActiveAccountKey)) ?? '';
    if (acctId.isEmpty) return;
    final raw = await DiskCache.readGlobal(_kMissedCallsLogKey);
    Map<String, dynamic> all = {};
    if (raw != null && raw.isNotEmpty) {
      try { all = jsonDecode(raw) as Map<String, dynamic>; } catch (_) {/* start fresh */}
    }
    final list = ((all[acctId] as List?) ?? const []).map((e) => e.toString()).toList();
    list.insert(0, line);
    if (list.length > 8) list.removeRange(8, list.length);
    all[acctId] = list;
    await DiskCache.writeGlobal(_kMissedCallsLogKey, jsonEncode(all));
    await _ensureLocalInit();
    final n = list.length;
    await _local.show(
      _kMissedCallsSummaryId,
      n > 1 ? '$n missed calls' : line,
      n > 1 ? list.first : '',
      NotificationDetails(
        android: AndroidNotificationDetails(
          _callsChannel.id, _callsChannel.name,
          channelDescription: _callsChannel.description,
          importance: Importance.high, priority: Priority.high,
          groupKey: _kMissedCallsGroupKey,
          setAsGroupSummary: true,
          category: AndroidNotificationCategory.missedCall,
          styleInformation: InboxStyleInformation(
            list, contentTitle: n > 1 ? '$n missed calls' : line, summaryText: 'AvaTOK',
          ),
        ),
      ),
      payload: 'chat',
    );
  } catch (_) {/* best-effort — grouping is cosmetic, the per-caller banner already shown */}
}

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
  // [AVANOTIF-VM-1] Resolve the RECIPIENT's own name for this sender before
  // falling back to the sender's self-declared fromName. See _resolveDisplayName.
  final rawFromUid = (d['fromUid'] ?? '').toString();
  final rawFromPhone = (d['fromPhone'] ?? '').toString();
  final rawFromName = (d['fromName'] ?? '').toString();
  final resolved = await _resolveDisplayName(
    fromUid: rawFromUid.isEmpty ? null : rawFromUid,
    fromPhone: rawFromPhone.isEmpty ? null : rawFromPhone,
    fromName: rawFromName.isEmpty ? null : rawFromName,
    unknownFallback: 'AvaTOK', // unchanged historical fallback for chat messages
  );
  final who = resolved.name;
  await _track('name_resolution', {
    'surface': 'message',
    'tier': resolved.tier,
    'had_from_uid': rawFromUid.isNotEmpty,
    'had_from_phone': rawFromPhone.isNotEmpty,
  });
  final count = await _bumpBadge('message');
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
  // Reachable from BOTH the bg isolate (firebaseBackgroundHandler) and — since
  // [PUSH-FG-BANNER-1] — the foreground path. `_track` routes per-isolate:
  // `_bgTrack`'s durable queue in the bg isolate (no Analytics there), straight
  // to PostHog in the main one.
  await _track('push_shown', {
    'channel': 'messages',
    'type': 'message',
    // [PUSH-FG-BANNER-1] Which isolate actually drew the banner. Before this
    // fix, foreground messages drew NOTHING and `push_shown` could therefore
    // only ever come from the bg isolate — so a `path:'foreground'` row is the
    // direct proof that the silent-with-screen-off bug is fixed.
    'path': BadgeService.inBackgroundIsolate ? 'background' : 'foreground',
    'has_preview': (d['preview'] ?? d['body'] ?? '').toString().trim().isNotEmpty,
  });
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
  final subKind = (d['subKind'] ?? '').toString().toLowerCase();
  if (d['recept']?.toString() == '1') return true;
  if (kind == 'receptionist' || type == 'receptionist') return true;
  if (category == 'missed' || type == 'missed') return true;
  // [AVANOTIF-VM-1] The consumer now forwards the missed-call/voicemail DOs'
  // `data.type` as `subKind` (consumers/fcm.ts buildPayload). This is the
  // reliable signal the fromName=='Ava' sniffing below was standing in for —
  // and, importantly, it ALSO catches the PSTN missed-call/voicemail case,
  // which fromName=='Ava' never did: a PSTN caller's `fromName` is their own
  // raw phone number, not 'Ava', so those pushes fell through to the plain
  // chat-message banner (title = a raw phone number, body = "New message") —
  // exactly the owner's reported screenshot. Additive, does not replace the
  // checks above or below.
  if (subKind == 'receptionist' || subKind == 'voicemail') return true;
  // Fallback while any path still strips the tag: the reception DO posts the
  // voicemail as fromName='Ava'. Kept per spec — do not delete on an assumption.
  return (d['fromName'] ?? '').toString() == 'Ava';
}

/// Missed-call / receptionist ("Ava took a message") banner on the dedicated
/// Calls channel. Each caller gets its OWN notification id (see
/// [_missedCallNotifId]) grouped under [_kMissedCallsGroupKey], with a summary
/// notification kept on the original fixed id (8002) for continuity — see
/// [AVANOTIF-VM-1] above. High importance + sound + vibration wakes the screen.
Future<void> _showMissedCallNotif(Map<String, dynamic> d) async {
  // [AVANOTIF-VM-1] Resolve the RECIPIENT's own name for this caller. `fromPub`
  // (present on both PSTN and in-app receptionist pushes) is the caller's uid
  // when known; `caller_phone`/`fromPhone` the E.164 number. Deliberately do NOT
  // feed the payload's own `fromName` into the resolver here: for receptionist
  // pushes it is literally 'Ava' (the assistant, not the caller — the OLD title
  // could read "Ava took a message from Ava" when no other field was set), and
  // for PSTN it is just the same raw phone number `fromPhone` already covers via
  // the formatted-phone fallback tier.
  final fromUid = (d['fromPub'] ?? d['fromUid'] ?? '').toString();
  final fromPhone = (d['fromPhone'] ?? d['caller_phone'] ?? '').toString();
  final rawCallerName = (d['callerName'] ?? '').toString();
  final resolved = await _resolveDisplayName(
    fromUid: fromUid.isEmpty ? null : fromUid,
    fromPhone: fromPhone.isEmpty ? null : fromPhone,
    fromName: rawCallerName.isEmpty ? null : rawCallerName,
  );
  final who = resolved.name;
  await _track('name_resolution', {
    'surface': 'missed_call',
    'tier': resolved.tier,
    'had_from_uid': fromUid.isNotEmpty,
    'had_from_phone': fromPhone.isNotEmpty,
  });

  final preview = (d['preview'] ?? d['body'] ?? '').toString().trim();
  final count = await _bumpBadge('missed_call');
  // [AVANOTIF-VM-1] Whether this missed-call surface actually carries (or will
  // carry) a voicemail/receptionist message, vs a plain unanswered call with
  // nothing left. Drives the body copy (owner's own phrasing: "Check your
  // AvaTOK inbox for a voice message" / spec's "Left you a voice message").
  final subKind = (d['subKind'] ?? '').toString().toLowerCase();
  final hasVoicemail = subKind == 'voicemail' || subKind == 'receptionist' ||
      d['recept']?.toString() == '1' || (d['fromName'] ?? '') == 'Ava';
  final title = 'Missed call from $who';
  final body = preview.isNotEmpty
      ? preview // e.g. a transcript snippet — WhatsApp-style preview
      : (hasVoicemail
          ? 'Left you a voice message · tap to listen'
          : 'Tap to call back');
  final styleInfo = preview.isNotEmpty
      ? BigTextStyleInformation(preview, contentTitle: title)
      : null;
  // CALLFIX-21: add "Call back" action button. Extract the caller's peerId from
  // the data (fromPub is the caller's public ID used to dial them back).
  final peerId = (d['fromPub'] ?? '').toString();
  final hasCallbackAction = peerId.isNotEmpty;
  // CALLFIX-R7 / [AVANOTIF-VM-1]: store the peerId so the callback action
  // handler can access it. GLOBAL (device-level), not scoped: this banner is
  // routinely shown from the bg isolate, where `AccountScope.id` is unset — a
  // SCOPED write there used to land in the wrong ("default") on-disk folder
  // while the tap (main isolate, real AccountScope.id) read the real one, so
  // "Call back" on a backgrounded missed call could silently read nothing.
  if (hasCallbackAction) {
    await DiskCache.writeGlobal('last_missed_call_peer_id', peerId);
  }
  await _ensureLocalInit(); // bg isolate: plugin isn't init'd here otherwise → crash
  // [AVANOTIF-VM-1] Stable per-caller id (phone, else uid, else the resolved
  // name) so a second missed call from a DIFFERENT person gets its OWN banner
  // instead of silently overwriting the first — grouped under one summary.
  final callerKey = fromPhone.isNotEmpty ? fromPhone : (fromUid.isNotEmpty ? fromUid : who);
  final notifId = _missedCallNotifId(callerKey);
  final androidDetails = AndroidNotificationDetails(
    _callsChannel.id, _callsChannel.name,
    channelDescription: _callsChannel.description,
    importance: Importance.high, priority: Priority.high,
    number: count,
    ticker: title,
    category: AndroidNotificationCategory.missedCall,
    styleInformation: styleInfo,
    groupKey: _kMissedCallsGroupKey,
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
    notifId,
    title,
    body,
    NotificationDetails(android: androidDetails),
    payload: 'chat',
  );
  await _updateMissedCallsSummary('$title — ${hasVoicemail ? "voicemail" : "no voicemail"}');
  await _bgTrack('push_shown', {
    'channel': 'calls', 'type': 'missed', 'has_callback': hasCallbackAction,
    'has_voicemail': hasVoicemail, 'name_tier': resolved.tier,
  });
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
  final count = await _bumpBadge('now_free');
  if (peerId.isNotEmpty) {
    // Reuse the existing callback plumbing: the tap handler reads this key.
    // GLOBAL — this banner routinely fires from the bg isolate (no AccountScope).
    await DiskCache.writeGlobal('last_missed_call_peer_id', peerId);
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
  final peerId = await DiskCache.readGlobal('last_missed_call_peer_id');
  Analytics.capture('now_free_callback_started', {
    'peer_id': peerId ?? '',
  });
  _clearBadge('now_free_callback_tap');
  navigatorKey.currentState?.popUntil((r) => r.isFirst);
  // The redial itself is driven by the chat/dial flow the missed-call callback
  // already routes to (peerId stored above); wiring a cold-start auto-dial is a
  // follow-up, kept identical to _handleMissedCallCallback so behaviour matches.
}

/// Show the native full-screen incoming-call UI (CallKit / ConnectionService),
/// which rings and wakes the screen even when locked or the app is killed.
Future<void> _showIncoming(Map<String, dynamic> d, {String route = 'unknown'}) async {
  if (d['type'] != 'call') {
    AvaLog.I.log('call', 'incoming skipped (type=${d['type']})');
    // [CALL-RING-OBS-1] Even the skip is worth a row — a ring that never
    // reaches CallKit because of a payload shape change is otherwise invisible.
    await _track(CallEvents.callIncomingShown, {
      'call_id': (d['callId'] ?? '').toString(),
      'route': route,
      'shown': false,
      'skip_reason': 'wrong_type',
      'payload_type': (d['type'] ?? '').toString(),
    });
    return;
  }
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
  // [CALL-RING-OBS-1] The single most important missing row in the 2026-07-14
  // incident: `call_incoming_shown` was DECLARED in call_telemetry_events.dart
  // and never emitted anywhere, so "the phone rang but no call screen appeared"
  // could not be confirmed, localised to a route, or attributed to FSI policy.
  //
  // What each field buys us:
  //  · route           — 'ws' | 'fcm_bg' | 'fcm_fg'. The WS path wins the race
  //                      for ONLINE-but-backgrounded callees by design, so if
  //                      the screen only fails on route='ws' that is the answer.
  //  · lifecycle       — Android only launches a full-screen intent instead of a
  //                      heads-up banner in specific states; 'resumed' vs
  //                      'paused' vs null (bg isolate) is the discriminator.
  //  · fsi_granted     — measured AT RING TIME. `call_fsi_permission` is a
  //                      once-per-app-start probe, which proves nothing about
  //                      the moment that matters.
  //  · shown           — did showCallkitIncoming actually return without error.
  //  · latency_ms      — ring frame → CallKit handed the UI over.
  bool fsiGranted = false;
  try {
    if (NativeVoiceAudio.isSupported) {
      fsiGranted = await NativeVoiceAudio.instance.canUseFullScreenIntent();
    }
  } catch (_) {/* probe must never block the ring */}
  // `WidgetsBinding.instance` throws if the binding isn't initialised, which is
  // exactly the case in the FCM background isolate — read it defensively so ring
  // telemetry can never be the thing that kills the ring.
  // 'no_binding' (bg isolate) and 'none' (binding up, state not yet reported)
  // are distinct and both meaningful — keep them as sentinels, not nulls.
  String lifecycle = 'no_binding';
  try {
    lifecycle = WidgetsBinding.instance.lifecycleState?.name ?? 'none';
  } catch (_) {/* bg isolate: no binding — keep the sentinel */}
  final swShown = DateTime.now();
  Object? showErr;
  try {
    await FlutterCallkitIncoming.showCallkitIncoming(params);
  } catch (e) {
    showErr = e;
  }
  await _track(CallEvents.callIncomingShown, {
    'call_id': (d['callId'] ?? '').toString(),
    'kind': (d['kind'] ?? 'audio').toString(),
    'route': route,
    'shown': showErr == null,
    if (showErr != null) 'error': showErr.toString(),
    'fsi_granted': fsiGranted,
    'bg_isolate': BadgeService.inBackgroundIsolate,
    'lifecycle': lifecycle,
    // `AndroidParams.isShowFullLockedScreen` is `bool?` (every field on that
    // plugin class is nullable), and `_track` takes Map<String, Object> — so the
    // raw value would not compile. Coalesce to the plugin's own effective
    // default when unset.
    'locked_screen_param':
        incomingCallAndroidParams.isShowFullLockedScreen ?? false,
    'latency_ms': DateTime.now().difference(swShown).inMilliseconds,
    'trace_id': (d['trace_id'] ?? '').toString(),
  });
  // Preserve the pre-instrumentation contract: a CallKit failure still throws.
  if (showErr != null) throw showErr;
  // [DIALPAD-BIZ-CALLS] Named business-call screen (Accept · Decline · Send to
  // Ava AI Agent · Block) shown IN-APP, on top of the native CallKit ring, when
  // the app is foregrounded for a call that originated on the dialpad
  // (business channel) — friend-channel calls keep the plain CallKit ring +
  // CallScreen flow untouched. CallKit still owns background/lockscreen
  // ringing either way; this is additive UI on top of it.
  //
  // Gated on BOTH `businessCallUx` AND a `via:'dialpad'` marker on the push
  // payload. [place1to1Call] (the dialpad's only call-placing path) already
  // sends `via:'dialpad'` on the OUTGOING POST /api/call, ready for the server
  // to thread it through the ring push once that (separate) Worker routing
  // work lands — until then `d['via']` is simply absent and this stays dark
  // even with the flag on, so today's behaviour is unchanged either way.
  if (RemoteConfig.businessCallUx &&
      (d['via'] ?? '') == 'dialpad' &&
      WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) {
    navigatorKey.currentState?.push(MaterialPageRoute(
      builder: (_) => IncomingBusinessCallScreen(
        callId: (d['callId'] ?? '').toString(),
        fromUid: (d['fromPub'] ?? '').toString(),
        fromName: (d['fromName'] ?? 'AvaTOK').toString(),
        video: d['kind'] == 'video',
      ),
    ));
  }
}

class PushService {
  /// [WS-RING-1] Incoming ring delivered over the live InboxDO WebSocket
  /// (SyncHub frame {type:'call_ring', ...}) — the FCM-latency bypass for
  /// ONLINE callees. Mirrors the foreground FCM 'call' branch's guards
  /// (duplicate, glare, busy) and — unlike that branch — fires the
  /// device-ringing receipt immediately, so the caller's true-ringing signal
  /// arrives in <1s instead of after FCM's 8-15s. Whichever path (WS or FCM)
  /// lands first wins; the other is deduped by the shared _seenIncoming window.
  static Future<void> handleWsRing(Map<String, dynamic> f) async {
    final d = Map<String, dynamic>.from(f)..['type'] = 'call';
    final incomingId = (d['callId'] ?? '').toString();
    final kind = (d['kind'] == 'video') ? 'video' : 'audio';
    final fromPub = (d['fromPub'] ?? '').toString();
    if (incomingId.isEmpty) return;
    if (incomingId == gActiveCallId) {
      Analytics.capture('call_duplicate_push_ignored',
          {'call_id': incomingId, 'reason': 'ws_active'});
      return;
    }
    if (_seenIncoming(incomingId)) {
      Analytics.capture('call_duplicate_push_ignored',
          {'call_id': incomingId, 'reason': 'ws_dedup_window'});
      return;
    }
    // [CALL-GLARE-3] mutual dial → symmetric busy, same as the FCM branch.
    if (fromPub.isNotEmpty && hasPendingOutgoingTo(fromPub) &&
        gOutgoingCallId != null && incomingId != gOutgoingCallId) {
      Analytics.capture('call_glare_detected', {
        'call_id_in': incomingId,
        'call_id_out': gOutgoingCallId ?? '',
        'resolution': 'mutual_busy',
        'path': 'ws',
      });
      _signalStatus(incomingId, 'busy', fromPub,
          busyReason: 'active_call', receptionistEnabled: true);
      Analytics.capture('call_incoming_autobusy',
          {'call_id': incomingId, 'kind': kind, 'busy_reason': 'mutual_dial'});
      return;
    }
    if (callIsGenuinelyActive()) {
      _signalStatus(incomingId, 'busy', fromPub,
          busyReason: 'active_call', receptionistEnabled: true);
      Analytics.capture('call_incoming_autobusy',
          {'call_id': incomingId, 'kind': kind, 'busy_reason': 'on_another_call'});
      return;
    }
    if (gInCall) {
      // Stale gInCall — clear so we ring instead of silently rejecting (same
      // recovery as the FCM branch).
      gInCall = false;
      gActiveCallId = null;
      gInCallSince = 0;
    }
    Analytics.capture('call_incoming_received',
        {'call_id': incomingId, 'kind': kind, 'state': 'ws'});
    // Fire the true-ringing receipt NOW — this is the entire point of the WS
    // path: the caller's device-ringing signal no longer waits on FCM.
    final token = (d['ringReceiptToken'] ?? '').toString();
    if (token.isNotEmpty) {
      // ignore: unawaited_futures
      reportRinging(incomingId, token);
    }
    gIncomingRingingFrom = fromPub;
    gIncomingRingingCallId = incomingId;
    await _showIncoming(d, route: 'ws');
  }

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

  // CALLFIX-15: idempotent accept/start handling per call_id. Recently-processed
  // call ids (both accept and start paths), persisted in DiskCache so the
  // cold-start `_recoverAcceptedCall` path stays idempotent across a restart.
  //
  // ── [CALL-DEDUP-TTL-1 2026-07-14] Why this is now a Map, not a Set ──────────
  // This was `Set<String>`, persisted with NO TTL and only trimmed to the last
  // 20 ids. An id that landed here was therefore suppressed FOREVER — until 20
  // other calls happened to evict it.
  //
  // On its own that was survivable, because call ids were supposed to be unique
  // per call. But `place_1to1_call.dart` (and Recents / dialpad / team inbox)
  // minted `'avatok-<calleeUid>'` — a STABLE id per person. Combine the two and
  // you get the 2026-07-14 prod bug: the FIRST dialer call to someone was
  // handled and its id remembered permanently; the SECOND and every later call
  // reused that same id, matched here, and was dropped before it ever rang.
  // "She never heard a ring."
  //
  // Both halves are fixed — ids are unique now (core/calls/call_room_id.dart) —
  // but this half is fixed INDEPENDENTLY and on purpose. A dedup cache with no
  // TTL is a latent trap: it converts any future id-uniqueness regression into
  // silent, permanent, un-debuggable call loss. With a TTL the worst case
  // degrades to "duplicate rings for a while", which is noisy but visible.
  //
  // TTL is generous (6h) because its only job is de-duplicating the accept
  // events of ONE live call (CallKit can deliver actionCallAccept twice; the
  // cold-start recovery can re-enter minutes later). No real call outlives it,
  // and an 8-hex-char id colliding after 6h is not a thing that happens.
  //
  // The `_v2` key bump is deliberate and doubles as the migration. The old
  // `processed_call_ids` blob is a JSON List; this is a JSON Map, so they can't
  // be parsed interchangeably — but more importantly, every device currently in
  // the field has poisoned `avatok-user_…` entries in the old blob that are
  // suppressing real calls RIGHT NOW. Reading the old key would faithfully
  // restore that poison. Starting from a clean key drops it. The stale old blob
  // is left on disk (a few hundred bytes, never read again).
  static final Map<String, int> _processedCallIds = {};
  static const int _maxTrackedIds = 50;
  static const Duration _processedTtl = Duration(hours: 6);
  static const String _pKey = 'processed_call_ids_v2';
  static bool _processedIdsLoaded = false;

  /// Drop entries older than [_processedTtl]; keep the newest [_maxTrackedIds].
  static void _pruneProcessedIds() {
    final cutoff =
        DateTime.now().millisecondsSinceEpoch - _processedTtl.inMilliseconds;
    _processedCallIds.removeWhere((_, ts) => ts < cutoff);
    if (_processedCallIds.length > _maxTrackedIds) {
      // Evict OLDEST first. The old Set-based code trimmed by insertion order of
      // an unordered Set, i.e. it evicted essentially at random.
      final byAge = _processedCallIds.entries.toList()
        ..sort((a, b) => a.value.compareTo(b.value));
      for (final e in byAge.take(_processedCallIds.length - _maxTrackedIds)) {
        _processedCallIds.remove(e.key);
      }
    }
  }

  /// Check if a call_id was already processed (accept or start). Returns false
  /// if new, marks it as processed, and returns true on duplicates.
  static Future<bool> _isCallIdProcessed(String callId) async {
    if (callId.isEmpty) return false;
    // Load persisted map on first use, BEFORE the membership check — the old
    // code checked the in-memory set first, so a cold start could miss a
    // persisted id on the very first query.
    if (!_processedIdsLoaded) {
      _processedIdsLoaded = true;
      try {
        final raw = await DiskCache.read(scopedKey(_pKey));
        if (raw != null && raw.isNotEmpty) {
          final m = jsonDecode(raw) as Map<String, dynamic>;
          m.forEach((k, v) {
            final ts = v is int ? v : int.tryParse('$v');
            if (ts != null) _processedCallIds[k] = ts;
          });
        }
      } catch (_) {/* best-effort */}
    }
    _pruneProcessedIds();
    final seenAt = _processedCallIds[callId];
    if (seenAt != null) {
      final ageMs = DateTime.now().millisecondsSinceEpoch - seenAt;
      // [CALL-DEDUP-TTL-1] A suppression is only legitimate when it happens
      // SECONDS after the original — that's a duplicate delivery of one call.
      // A suppression minutes or hours later means we just silently killed what
      // was almost certainly a real, separate call. Surface it loudly rather
      // than letting it be invisible the way it was on 2026-07-14.
      Analytics.capture('call_dedup_suppressed', {
        'call_id': callId,
        'age_ms': ageMs,
        'call_id_shape': CallRoomId.isPerCallee(callId)
            ? 'uid'
            : (CallRoomId.isPerCall(callId) ? 'uuid' : 'other'),
        // The alert condition: true = we probably dropped a genuine new call.
        'suspicious': ageMs > 120000,
        'tracked_ids': _processedCallIds.length,
      });
      return true;
    }
    _processedCallIds[callId] = DateTime.now().millisecondsSinceEpoch;
    _pruneProcessedIds();
    try {
      await DiskCache.write(scopedKey(_pKey), jsonEncode(_processedCallIds));
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

  /// Notify the server that this device has received the incoming call push
  /// and is ringing, so the caller can play ringback and start the ring window.
  /// Unauthenticated since it runs in the background isolate where Clerk auth is offline.
  static Future<void> reportRinging(String callId, String ringReceiptToken) async {
    if (callId.isEmpty || ringReceiptToken.isEmpty) return;
    try {
      final client = HttpClient();
      final uri = Uri.parse('https://$kSignalingHost/api/call/ringing');
      final request = await client.postUrl(uri);
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode({
        'callId': callId,
        'ringReceiptToken': ringReceiptToken,
      }));
      final response = await request.close();
      await response.drain();
      client.close();
      AvaLog.I.log('push', 'Reported ringing for callId=$callId: HTTP ${response.statusCode}');
    } catch (e) {
      AvaLog.I.log('push', 'Failed to report ringing for callId=$callId: $e');
    }
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

  /// Has the user finished onboarding? The single notification-permission ask is
  /// deferred to the onboarding "notifications" step until then (see the ordering
  /// contract in [_init]). When the answer is unknown we return false → defer the
  /// ask, which is the safe default (never prompt before onboarding owns it).
  static Future<bool> _onboardingComplete() async {
    try {
      return await OnboardingStore().isDone();
    } catch (_) {
      return false;
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
    // ── Notification-permission ordering contract (AVA-ONBOARD-1) ─────────────
    // There must be exactly ONE OS notification-permission dialog on a fresh
    // install, and the onboarding "notifications" step OWNS it. This init()
    // historically called requestPermission() at app start, which fired the OS
    // dialog BEFORE onboarding had even rendered — then the onboarding step
    // asked a SECOND time (the owner-reported double prompt).
    //
    // Fix: while onboarding is NOT yet complete we only READ the current status
    // (getNotificationSettings never prompts) and let the onboarding step do the
    // single ask. Once onboarding is done (every returning/existing user) we
    // request as before, so someone who skipped earlier is still re-offered on a
    // later launch — and because the OS only shows its dialog once, this is a
    // no-op read for anyone who already answered.
    //
    // IMPORTANT: FCM token retrieval + notification-channel setup below do NOT
    // require GRANTED notification permission (only DISPLAYING a notification
    // does — documented FCM behavior), so token registration keeps working even
    // when we defer the ask. Do NOT move a requestPermission() ahead of this
    // gate; that reintroduces the double prompt.
    final onboardingDone = await _onboardingComplete();
    final perm = onboardingDone
        ? await FirebaseMessaging.instance.requestPermission()
        : await FirebaseMessaging.instance.getNotificationSettings();
    // Telemetry: a denied/notDetermined notification permission is a common
    // reason a device never receives calls/messages — capture it so "user never
    // got the push" is queryable instead of invisible. `requested` distinguishes
    // an actual ask from a pre-onboarding status read.
    Analytics.capture('push_permission', {
      'status': perm.authorizationStatus.name, // authorized|denied|notDetermined|provisional
      'requested': onboardingDone,
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
    // [AVANOTIF-VM-1] Build the bg-isolate-readable name cache now (main isolate,
    // account is scoped by this point) and keep it fresh whenever the recipient's
    // own AvaTOK contact book changes. Contact-override renames have no change
    // stream, so they ride the same rebuild cadence (init + every foreground FCM
    // below) — a short staleness window, not a correctness gap.
    unawaited(_rebuildNameCache());
    ContactsStore.changes.listen((_) => unawaited(_rebuildNameCache()));
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
      // [AVANOTIF-VM-1] Cheap opportunistic refresh — keeps contact-override
      // renames (no change stream of their own) from going stale for long.
      unawaited(_rebuildNameCache());
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
          // [AVACALL-CANCEL-1] Cache the terminal marker so a call accepted in
          // the same instant (before its CallSession subscribes) is ended cleanly.
          _noteTerminalCall(callId);
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
        } else {
          // [PUSH-FG-BANNER-1 2026-07-14] Show a banner unless the user is
          // DEMONSTRABLY looking at this exact thread.
          //
          // This branch used to do nothing but `syncFromPush()`, on the comment
          // "App is open: the live InboxDO socket should already have it." The
          // message did arrive — but the user was never TOLD. That is the
          // 2026-07-14 report: "she replied while I was walking about with my
          // screen off and I never heard any beep or ping."
          //
          // The bug is the word "foreground". FCM routes to `onMessage` whenever
          // the app PROCESS is foreground, which is NOT the same as the user
          // looking at the screen. All of these hit this path and got silence:
          //   · screen off, phone in a pocket, AvaTalk still the top activity
          //     ← the reported case
          //   · user in AvaDialer / Marketplace / AvaBrain, not AvaTalk
          //   · user in AvaTalk but reading a DIFFERENT thread
          //
          // Proof it was never a delivery problem: EVERY `push_fanout_result`
          // (kind:notify) was followed by `fcm_fg_received` within ~300ms, and
          // `push_shown` never fired even once. The push worked perfectly; the
          // app simply chose not to tell anyone.
          //
          // Suppress ONLY when both hold:
          //   1. lifecycle == resumed  → screen on AND app visible. `paused` /
          //      `inactive` / `hidden` all mean the user cannot see us.
          //   2. the push's `conv` matches the thread currently on screen. When
          //      `conv` is absent (older senders, forwards, contact shares) we
          //      fail SAFE and show the banner — a redundant banner is a far
          //      smaller sin than a silent phone.
          final lifecycle = WidgetsBinding.instance.lifecycleState;
          final resumed = lifecycle == AppLifecycleState.resumed;
          final conv = (d['conv'] ?? '').toString();
          final onThisThread =
              conv.isNotEmpty && conv == ActiveThread.convKey;
          final suppress = resumed && onThisThread;
          if (suppress) {
            Analytics.capture('push_fg_banner_suppressed', {
              'reason': 'thread_open',
              'conv': conv,
              'lifecycle': lifecycle?.name ?? 'unknown',
            });
          } else {
            // ignore: unawaited_futures
            _showMessageNotif(d);
            Analytics.capture('push_fg_banner_shown', {
              'lifecycle': lifecycle?.name ?? 'unknown',
              'has_conv': conv.isNotEmpty,
              'on_this_thread': onThisThread,
              // Why we decided to ring. 'not_resumed' is the reported bug's
              // signature: app "foreground" to FCM, invisible to the human.
              'reason': !resumed
                  ? 'not_resumed'
                  : (conv.isEmpty ? 'no_conv_in_payload' : 'other_thread'),
            });
          }
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
        // [CALL-GLARE-3] (owner decision 2026-07-07 — REPLACES the CALL-GLARE-1
        // auto-merge): two users dialing EACH OTHER at the same time now BOTH get
        // "busy on another call" + the busy card (Cancel / Notify me / Leave a
        // message for Ava). No auto-accept, no folding into one room. Symmetric:
        // each device busy-replies the crossing incoming push and keeps its own
        // outgoing dial, so each caller sees the other as busy and chooses.
        final glareFrom = (d['from'] ?? '').toString();
        if (glareFrom.isNotEmpty && hasPendingOutgoingTo(glareFrom) &&
            gOutgoingCallId != null && incomingId.isNotEmpty &&
            incomingId != gOutgoingCallId) {
          Analytics.capture('call_glare_detected', {
            'call_id_in': incomingId,
            'call_id_out': gOutgoingCallId ?? '',
            'resolution': 'mutual_busy',
          });
          _signalStatus(incomingId, 'busy', (d['fromPub'] ?? '').toString(),
              busyReason: 'active_call', receptionistEnabled: true);
          Analytics.capture('call_incoming_autobusy', {
            'call_id': incomingId, 'kind': kind, 'busy_reason': 'mutual_dial',
          });
          return;
        }
        // [RECEPT-CALLBACK-PREEMPT-1 REMOVED] (owner decision 2026-07-07): while
        // we're leaving a message on B's Ava and B calls back, B now gets the
        // normal busy card (Cancel / Notify me / Leave a message) instead of
        // ringing through into a half-open call where Ava was still audible.
        // The generic autobusy below handles it.
        if (callIsGenuinelyActive()) {
          // [BUSY-CARD-1] Tell the caller WHY (on another call) and whether Ava can
          // take a message, so they get the busy card. Ava is ALWAYS-ON as of
          // 2026-07-07 (per-user off switch retired), so receptionist_enabled
          // defaults true; the local mirror can only confirm it.
          final fromPub = (d['fromPub'] ?? '').toString();
          (() async {
            bool re = true;
            try {
              final v = await DiskCache.read('receptionist_enabled');
              if (v != null && v.isNotEmpty) re = v == '1';
              re = true; // ALWAYS-ON override — kept for one release of telemetry
            } catch (_) {}
            _signalStatus(incomingId, 'busy', fromPub,
                busyReason: 'active_call', receptionistEnabled: re);
          })();
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
        _showIncoming(d, route: 'fcm_fg');
        return;
      }
      _showIncoming(d, route: 'fcm_fg');
    });
    // The FCM token rotates (reinstall, restore, periodic refresh). Always
    // re-register the new one so the device never silently stops receiving
    // calls/pushes — this was a key cause of "no call came through".
    FirebaseMessaging.instance.onTokenRefresh.listen((t) {
      AvaLog.I.log('push', 'FCM token refreshed — re-registering');
      Analytics.capture('push_token_refreshed', {});
      // [FCM-DEDUPE] force:true — a rotation is exactly when the credential must be
      // pushed immediately, so it must never be swallowed by the unchanged-token
      // guard (and it refreshes the stored fingerprint for subsequent opens).
      _postToken(t, force: true, trigger: 'token_refresh').catchError((e) {
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
  ///
  /// [conv] is the conversation key AS THE RECIPIENT SEES IT — NOT as the sender
  /// does. Conv keys are device-relative: a DM thread is `'1:<theOtherPerson>'`,
  /// so the recipient's key for this thread is `'1:<MY uid>'`, not `'1:<their
  /// uid>'`. Groups are symmetric (`'g:<gid>'`), so either side computes the same
  /// value. Get this backwards and the recipient's foreground handler simply
  /// never matches, falling back to "always show a banner" — noisy, but never
  /// silent. See [PUSH-FG-BANNER-1].
  ///
  /// Omit [conv] and the recipient shows a banner for every foreground message
  /// in that push. That is the deliberate fail-safe direction.
  static void notifyMessage(List<String> uids, String fromName,
      {String? preview, String? conv}) {
    if (uids.isEmpty) return;
    final body = <String, dynamic>{'to': uids, 'fromName': fromName};
    final p = (preview ?? '').trim();
    // Include a short preview so the recipient can read the message from the
    // notification shade (WhatsApp-style). Capped server-side too.
    if (p.isNotEmpty) body['preview'] = p.length > 140 ? p.substring(0, 140) : p;
    final c = (conv ?? '').trim();
    if (c.isNotEmpty) body['conv'] = c;
    ApiAuth.postJson(kNotifyUrl, body).ignore();
  }

  /// [ISSUE-BADGE-UNREAD-1] Reconcile the app-icon badge against real unread
  /// state (AvaTOK chat + AvaDialer SMS/OTP) and collapse the notifications when
  /// nothing is unread. Call when the user opens the app or views the chat list.
  ///
  /// Kept as the public API, but it is NO LONGER a blind clear: if messages
  /// genuinely are unread the badge survives opening the app and shows the true
  /// count. Delegates to [BadgeService.recompute] — see that class for why the
  /// old "reset to 0 on tap" model left the owner with a stuck number.
  static Future<void> clearMessageBadge() =>
      BadgeService.recompute(source: 'clear_message_badge');

  /// Tell the caller a call was declined / busy — over the WS room (fast path)
  /// AND via the server push (works even if the socket can't be held).
  static void _signalStatus(String callId, String status, String callerNpub,
      {String? busyReason, bool receptionistEnabled = false, String? pronoun}) {
    if (callId.isEmpty) return;
    // [BUSY-CARD-1] When we auto-busy a caller, attach why we're busy + whether Ava
    // can take a message, so the CALLER renders the personalized busy card instead
    // of a cold "User is busy". Additive: old callers ignore the extra fields.
    final extra = <String, dynamic>{};
    if (status == 'busy' && busyReason != null && busyReason.isNotEmpty) {
      extra['busy_reason'] = busyReason;
      extra['receptionist_enabled'] = receptionistEnabled;
      if (pronoun != null && pronoun.isNotEmpty) extra['pronoun'] = pronoun;
    }
    // fast path: signaling room (carries the metadata too, so the card shows without
    // waiting for the durable FCM — avoids a race where the plain WS 'busy' wins).
    try {
      final ch = WebSocketChannel.connect(
          Uri.parse('wss://$kSignalingHost/room/$callId?id=ctl-${DateTime.now().millisecondsSinceEpoch}'));
      ch.sink.add(jsonEncode({'type': status, ...extra}));
      Future.delayed(const Duration(milliseconds: 800), () {
        try { ch.sink.close(); } catch (_) {}
      });
    } catch (_) {/* best effort */}
    // durable path: server pushes the status to the caller
    if (callerNpub.isNotEmpty) {
      ApiAuth.postJson(kCallStatusUrl,
          {'to': callerNpub, 'callId': callId, 'status': status, ...extra}).ignore();
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

  /// [DIALPAD-BIZ-CALLS] Public wrapper around [_declineRouting] for the
  /// in-app named incoming-business-call screen (Decline / Block actions),
  /// which isn't a native CallKit action and so can't reach the private
  /// handler otherwise. Same signalling as a CallKit decline: status +
  /// missed-call log entry. Callers should also best-effort end the native
  /// CallKit ring (`FlutterCallkitIncoming.endCall(callId)`) and clear the
  /// `gIncomingRingingFrom`/`gIncomingRingingCallId` globals themselves.
  static Future<void> declineIncomingCall(Map extra) => _declineRouting(extra);

  /// [DIALPAD-BIZ-CALLS Phase C] "Send to Ava AI Agent" from the in-app named
  /// incoming-business-call screen. Signals `decline_agent` to the CALLER
  /// (fast signaling-room WS + durable /api/call-status, same dual path as a
  /// decline) — the caller's CallSession then hands its leg to the agent flow
  /// (routing_decision reason MANUAL_SEND_TO_AGENT, plan §13). Old caller
  /// clients that don't know `decline_agent` end the ring like a plain
  /// decline-shaped status; they never dead-end.
  static Future<void> sendToAgentIncomingCall(Map extra) async {
    final callId = (extra['callId'] ?? '').toString();
    final from = (extra['from'] ?? '').toString();
    _signalStatus(callId, 'decline_agent', from);
    // CALL-GLARE-1: same dedupe key as decline — the two are mutually exclusive
    // outcomes of one ring, and CallKit can double-fire either.
    if (_onceCallEvent(callId, 'declined')) {
      Analytics.capture('call_incoming_declined', {
        'call_id': callId,
        'routed_to': 'decline_agent',
      });
    }
    _logMissed(extra);
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
  ///
  /// [CALL-REACH-1] `force` bypasses the [FCM-DEDUPE] unchanged-token guard and
  /// `trigger` labels the call site in telemetry (app_open / account_switch_in /
  /// app_resume / token_refresh). Account switch-IN MUST force: switch-OUT sets
  /// account_devices.active=0 and the /api/register POST is the only thing that
  /// sets it back to 1 — the dedupe guard was silently skipping exactly that
  /// POST (token unchanged), leaving the account permanently unreachable
  /// (token_count=0, mapped_inactive=1 → every call fell to the Ava agent).
  static Future<void> registerToken(String uid, {bool force = false, String trigger = 'app_open'}) async {
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
        Analytics.capture('push_register_failed', {'reason': 'fcm_token_null', 'trigger': trigger});
        return;
      }
      await _postToken(token, force: force, trigger: trigger);
    } catch (e) {
      AvaLog.I.log('push', 'register token FAILED: $e');
      // Surface the FCM/Firebase error (e.g. FIS_AUTH_ERROR — a Firebase
      // Installations auth failure) as its own event so the root cause behind
      // "no device registered" is visible per-user in PostHog.
      final err = e.toString();
      Analytics.capture('push_register_failed', {
        'reason': 'exception',
        'trigger': trigger,
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
      // [PUSH-DEVICE-OBS-1] Emit `device_id` so this row JOINS against D1
      // `account_devices` / `device_tokens` and against the consumer's
      // `push_fanout_result`. Without it, `mapped_active_no_token:2` /
      // `mapped_inactive:3` (2026-07-14 incident) is an unattributable number:
      // we could see that N device rows had no token, but not WHICH device the
      // live phone was — i.e. we could not prove the push went to a dead token.
      Analytics.capture('account_device_mapped', {
        'active': active,
        'device_id': deviceId,
      });
    } catch (e) {
      AvaLog.I.log('push', 'mapDevice(active=$active) failed: $e');
    }
  }

  /// [FCM-DEDUPE] Per-account scoped fingerprint of the token most recently
  /// registered SUCCESSFULLY. PostHog (7d prod): the token was re-POSTed to the
  /// worker (a KV/D1 write) on essentially every app open even when nothing
  /// changed — ~162 "registered FCM token … -> HTTP 200" diag lines/week and ~97
  /// push_token_registered/3d for a single user. The token belongs to the device
  /// but the REGISTRATION maps the ACTIVE account → token, so the guard is
  /// account-scoped (DiskCache.read/write is namespaced by AccountScope.id): a
  /// switch to a different account still re-POSTs (its scoped store has no/old
  /// token), while a plain relaunch on the same account with the same token is a
  /// no-op. Only a SUCCESSFUL (HTTP 200) registration updates it, so a failed
  /// POST is retried on the next open rather than masked.
  static const String _kLastRegisteredTokenKey = 'push_last_registered_token_v1';

  /// [CALL-REACH-1] When the last SUCCESSFUL registration happened (per-account
  /// scoped, ms since epoch). The dedupe guard is now a TTL, not a permanent
  /// skip: the server prunes tokens on FCM 404 (consumers/src/fcm.ts) and NEVER
  /// tells the client, so "I registered this token once" must expire. Without
  /// this, a prune while the device was idle made the account permanently
  /// unreachable — the app would open, read the cache, skip the POST, and every
  /// call kept falling to the Ava agent (the 2026-07-19 fleet-wide diagnosis:
  /// 298 push_no_device vs 236 call_push_sent over 30 days).
  static const String _kLastRegisteredAtKey = 'push_last_registered_at_v1';

  /// Re-POST at most this often when the token is unchanged. Cheap (one D1
  /// upsert) and idempotent server-side; bounds the worst-case unreachable
  /// window after a silent server-side prune to one app-open + TTL.
  static const Duration _reRegisterTtl = Duration(hours: 12);

  /// POST the current token to the server (uid is derived server-side from the
  /// NIP-98 signature). Used by registerToken AND by onTokenRefresh.
  ///
  /// [force] bypasses the [FCM-DEDUPE] unchanged-token guard — the token-ROTATION
  /// callback (onTokenRefresh) and any future server-driven invalidation pass it
  /// so a fresh/rotated credential is always pushed immediately.
  static Future<void> _postToken(String token, {bool force = false, String trigger = 'app_open'}) async {
    // [MULTIACCT-2] Send the stable per-device id so the server keys the token by
    // DEVICE (device_tokens) and maps the ACTIVE account to it (account_devices).
    // A token refresh updates the single device row; a login/switch flips the
    // mapping — neither orphans the token, so the callee never becomes silently
    // unreachable after a re-login.
    final deviceId = await DeviceId.get();
    // [FCM-DEDUPE]+[CALL-REACH-1] Short-circuit an unchanged re-registration for
    // this account — but ONLY within the TTL. The server can prune our token
    // (FCM 404) or deactivate our mapping (account switch elsewhere) without
    // telling us, so an unchanged token is only trustworthy for a bounded time.
    if (!force) {
      try {
        final last = await DiskCache.read(_kLastRegisteredTokenKey);
        final atRaw = await DiskCache.read(_kLastRegisteredAtKey);
        final at = int.tryParse(atRaw ?? '') ?? 0;
        final ageMs = DateTime.now().millisecondsSinceEpoch - at;
        final fresh = at > 0 && ageMs < _reRegisterTtl.inMilliseconds;
        if (last != null && last == token && fresh) {
          Analytics.capture('push_register_skipped', {
            'reason': 'unchanged',
            'trigger': trigger,
            'age_ms': ageMs,
            'device_id': deviceId,
            'token_prefix': token.length >= 12 ? token.substring(0, 12) : token,
          });
          return;
        }
        if (last != null && last == token && !fresh) {
          // Fine-grained: distinguish a TTL-driven refresh from a genuinely new
          // token so the dashboard can measure how often the TTL is what saves us.
          Analytics.capture('push_register_ttl_refresh', {
            'trigger': trigger,
            'age_ms': ageMs,
            'device_id': deviceId,
          });
        }
      } catch (_) {/* best-effort — on any read error, fall through and POST */}
    }
    final res = await ApiAuth.postJson(
        kRegisterUrl, {'token': token, 'platform': 'fcm', 'device_id': deviceId});
    AvaLog.I.log('push', 'registered FCM token ${token.substring(0, 10)}… -> HTTP ${res.statusCode}');
    // Telemetry: distinguish a real registration (HTTP 200) from a server-side
    // failure (401/5xx). A non-200 here also means the device ends up with no
    // usable token row, so don't log it as "ok" — that masked the problem before.
    final ok = res.statusCode == 200;
    // [PUSH-DEVICE-OBS-1] `device_id` + `token_prefix` are the join keys that
    // let us ask "is the token the consumer actually sent to the one THIS live
    // device registered?" — the question the 2026-07-14 silent-notification
    // incident could not answer. token_prefix only (never the whole token):
    // an FCM token is a sending credential and must not land in analytics.
    final tokenPrefix = token.length >= 12 ? token.substring(0, 12) : token;
    // [CALL-REACH-1] The register response reports how many reachable devices the
    // server now has for this account ({ok, devices:N}). Surface it: devices==0
    // right after a 200 means the D1 write path is broken — the exact class of
    // silent failure that made callees unreachable. Fine-grained + queryable.
    int? serverDevices;
    if (ok) {
      try {
        final body = jsonDecode(res.body);
        if (body is Map && body['devices'] is num) serverDevices = (body['devices'] as num).toInt();
      } catch (_) {/* best-effort */}
    }
    Analytics.capture(ok ? 'push_register_ok' : 'push_register_failed', {
      'reason': ok ? 'registered' : 'http_error',
      'status': res.statusCode,
      'trigger': trigger,
      if (serverDevices != null) 'server_devices': serverDevices,
      'device_id': deviceId,
      'token_prefix': tokenPrefix,
    });
    if (ok && serverDevices == 0) {
      Analytics.capture('push_register_zero_devices', {
        'trigger': trigger,
        'device_id': deviceId,
      });
    }
    // Additional, explicit "token registered" event (kept ALONGSIDE
    // push_register_ok, not replacing it) so a successful FCM-token registration
    // is queryable under a stable name for the FIX-FCM tracking dashboard.
    if (ok) {
      // [FCM-DEDUPE] Remember the token we just registered (per-account scoped) so
      // the next same-account open with the same token is skipped, not re-POSTed.
      // [CALL-REACH-1] …and WHEN, so the skip expires (TTL) instead of lasting forever.
      try {
        await DiskCache.write(_kLastRegisteredTokenKey, token);
        await DiskCache.write(_kLastRegisteredAtKey, DateTime.now().millisecondsSinceEpoch.toString());
      } catch (_) {/* best-effort */}
      Analytics.capture('push_token_registered', {
        'platform': 'fcm',
        'status': res.statusCode,
        'device_id': deviceId,
        'token_prefix': tokenPrefix,
      });
    }
  }

  /// [AVACALL-CANCEL-1] Did we see a terminal call-status (cancel/bye/ended/…)
  /// for [callId] within the accept window? Synchronous, so the accept path can
  /// check it before painting "connecting". See [_terminalCallAt].
  static bool wasCallTerminated(String callId) {
    final ts = _terminalCallAt[callId];
    if (ts == null) return false;
    return DateTime.now().millisecondsSinceEpoch - ts < _kTerminalCallTtlMs;
  }

  /// [AVACALL-CANCEL-1] Best-effort DURABLE call-status read. Proxies the
  /// CallRoom DO's strongly-consistent state (answered / ended / terminal_status)
  /// via GET /api/call-state. Returns the terminal status string ('cancel' |
  /// 'bye' | 'ended' | …) when the call is already over, else null. FAIL-OPEN:
  /// any error / missing endpoint / timeout returns null so the accept proceeds
  /// exactly as before (never blocks a legitimate call on a flaky network).
  static Future<String?> fetchDurableCallStatus(String callId) async {
    if (callId.isEmpty) return null;
    try {
      final res = await ApiAuth.getSigned(
        '$kCallStateUrl?callId=${Uri.encodeQueryComponent(callId)}',
        timeout: const Duration(seconds: 4),
      );
      if (res.statusCode != 200) return null;
      final j = jsonDecode(res.body);
      if (j is! Map) return null;
      final terminal = (j['terminal_status'] ?? '').toString();
      if (terminal.isNotEmpty && _terminalCallStatus(terminal)) {
        _noteTerminalCall(callId); // fold into the cache for any later checker
        return terminal;
      }
      if (j['ended'] == true) return 'ended';
      return null;
    } catch (_) {
      return null; // fail-open
    }
  }

  /// CALLFIX-14 (glare): programmatically answer the currently-ringing incoming
  /// call — used when the user taps Call while the same peer is already ringing
  /// in. Dismisses the CallKit ring UI and opens the call like a normal accept.
  static Future<void> acceptRingingCall(String callId) async {
    // [AVACALL-CANCEL-1] Don't answer into a call the caller already cancelled.
    if (wasCallTerminated(callId)) {
      Analytics.capture('call_accepted_dead', {
        'call_id': callId,
        'via': 'accept_ringing_cache',
      });
      try { await FlutterCallkitIncoming.endCall(callId); } catch (_) {}
      return;
    }
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
