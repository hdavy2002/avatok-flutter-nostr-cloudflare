import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart' as ap;
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show MethodChannel;
import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:uuid/uuid.dart';

import '../core/account_storage.dart';
import '../core/active_thread.dart'; // [PUSH-FG-BANNER-1]
import '../core/analytics.dart';
import '../core/api_auth.dart';
import '../core/ava_log.dart';
import '../core/avatar_cache.dart'; // [NOTIF-STYLE-1] sender photo for the MessagingStyle Person
import '../core/background_tasks.dart' show bootstrapBackgroundIsolate; // [NOTIF-ACTIONS-1] headless auth + account scope
import '../core/badge_service.dart';
import '../core/chat_state.dart' show ChatFlagsStore, ReadStateStore; // [NOTIF-ACTIONS-1] mute + mark-as-read stores
import '../core/call_log_store.dart';
import '../core/calls/call_overlay.dart' show returnToActiveCall;
import '../core/calls/call_prewarm.dart' show CallPrewarm; // [CALL-PREWARM-1]
import '../core/calls/call_room_id.dart' show CallRoomId; // [CALL-DEDUP-TTL-1]
import '../core/calls/ring_delivery_contract.dart';
import '../core/calls/callkit_params.dart' show incomingCallAndroidParams;
import '../core/calls/call_session_manager.dart';
// [CALL-WS-AUTH-1] + [CALL-REL-R4-3] `Durable` is the awaited variant the ring
// path must use (the FCM background isolate can die before a lazy write lands);
// `roomTokenFor` lets the accept path tell "already have it" from "must recover".
import '../core/calls/call_session.dart'
    show rememberCallRoomTokenDurable, roomTokenFor;
import '../core/calls/call_telemetry_events.dart' show CallEvents;
import '../core/config.dart';
import '../core/disk_cache.dart';
import '../core/ice_cache.dart';
import '../core/onboarding_store.dart';
import '../core/presence_beat.dart'; // [CALL-PRESENCE-1] device heartbeat
import '../core/remote_config.dart';
import '../core/update_service.dart'; // [AVA-UPDATE-PUSH-1] instant app-update prompt on release
import '../core/voice/native_voice_audio.dart';
import '../features/avadial/contact_overrides.dart' show ContactOverrides;
import '../features/avadial/device_contacts.dart' show DeviceContacts;
// [CALLREC-UX-1] `show` deliberately narrow — these two Inbox files pull in a
// large widget tree, and only the deep-link tap handler below needs them.
import '../features/avadial/inbox/inbox_api.dart' show InboxApi, InboxThread;
import '../features/avadial/inbox/inbox_thread_screen.dart'
    show InboxThreadScreen;
import '../features/avatok/call_screen.dart';
import '../features/avatok/contacts.dart' show ContactsStore;
import '../features/avatok/incoming_business_call_screen.dart';
// [GCALL-W4-RING] group-call ring: busy check + accept destination
import '../features/conference/cloudflare_conference_controller.dart'
    show CloudflareConferenceController;
import '../features/conference/cloudflare_conference_screen.dart'
    show CloudflareConferenceScreen;
import '../identity/identity.dart' show AccountScope; // [AVANOTIF-VM-3] name-cache account namespacing
import '../sync/group_api.dart' show GroupApi; // [GRP-W3-RESYNC]
import '../sync/sync_hub.dart';
import 'call_ttl_gate.dart';

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
  String? activationMode,
  String? noAnswerReason,
});
final callStatusBus = StreamController<CallStatusEvent>.broadcast();

/// [PIV-2 2026-08-02] Broadcasts "this device's RING for `callId` is over", from
/// whatever source ended it — a CallKit notification tap, the branded screen's
/// own buttons, a ring timeout, or a server transition.
///
/// Why this is NOT `callStatusBus`: that bus is the CALLER-side signal channel,
/// and [CallSession] reacts to `decline` on it by opening the outcome menu
/// (call_session.dart `_statusSub`). Publishing the callee's own local decline
/// there would fire caller-side logic on the callee's device, and would ALSO
/// double-deliver on the FCM path, which already adds to `callStatusBus` and
/// then calls [applyRingTransition] — CallSession would see the same `decline`
/// twice and re-enter `_showOutcomeMenu`. A ring ending and a call status are
/// genuinely different facts, so they get different channels.
///
/// Emitted by [applyRingTransition] only, so every ring surface tears down
/// through the one reducer instead of each button re-implementing teardown.
typedef RingEndedEvent = ({String callId, String status});
final ringEndedBus = StreamController<RingEndedEvent>.broadcast();

// CALLFIX-14: Glare detection — track the currently ringing incoming call so if
// the user starts dialing while an incoming call from the same peer is ringing,
// we can auto-accept the incoming call instead. Cleared when the call is
// accepted/declined/missed.
String? gIncomingRingingFrom; // the peer's uid/seed that is currently ringing
String? gIncomingRingingCallId; // the callId of the incoming call

final _local = FlutterLocalNotificationsPlugin();

// [NOTIF-ICON-1] The status-bar glyph, for EVERY AvaTOK notification.
//
// Android does not render this drawable — it silhouettes it. Every pixel with
// non-zero alpha is painted flat white (tinted by
// @color/avatok_notification_accent inside the expanded notification) and all
// colour information is thrown away. Passing full-colour launcher art therefore
// yields a solid white BLOB beside the clock, which is exactly what AvaTOK shipped
// until now: both `AndroidInitializationSettings` calls said '@mipmap/ic_launcher'
// and NOT ONE `AndroidNotificationDetails` passed an `icon:` at all, so every
// banner inherited it.
//
// `ic_notification` is a purpose-drawn monochrome asset (double ring enclosing a
// capital A) at five densities. Its SOURCE OF TRUTH is app/android-res/drawable-*/
// — tool/postcreate.py patch_launcher_icon() copytree's that directory over
// android/app/src/main/res on EVERY CI build, so editing the res tree alone is a
// decoy that looks right locally and silently reverts in CI.
//
// No leading '@drawable/' and no extension: flutter_local_notifications resolves
// a bare name against the drawable folder itself.
const String _kNotifIcon = 'ic_notification';
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

// [AVACALL-INUI-2] Incoming-call channel for the BRANDED full-screen-intent
// notification that raises IncomingBusinessCallScreen over the LOCK SCREEN when
// the app isn't foregrounded. MAX importance is what makes Android honour
// `setFullScreenIntent`. Sound + vibration are OFF ON PURPOSE: the native
// CallKit ring is still posted underneath and OWNS the ringtone — this
// notification is only the branded full-screen UI trigger, so we never
// double-ring. Distinct id so the user can tune it separately.
const _incomingCallChannel = AndroidNotificationChannel(
  'avatok_incoming_calls', 'Incoming calls',
  description: 'Branded incoming-call screen', importance: Importance.max,
  playSound: false, enableVibration: false,
);
// [AVA-UPDATE-PUSH-1] App-update channel — the low-key "A new version is
// available" banner posted when an `app_update` push arrives while the app is
// BACKGROUND/terminated (the foreground case shows the in-app dialog instead).
// Deliberately NOT high-importance and sound/vibration OFF: a new build is not
// urgent like a call or message, so it must never wake the screen or ring. A
// distinct id so the user can mute updates independently.
const _updatesChannel = AndroidNotificationChannel(
  'avatok_updates', 'App updates',
  description: 'A new version of AvaTOK is available',
  importance: Importance.defaultImportance,
  playSound: false, enableVibration: false,
);
// [NOTIF-ACTIONS-1 2026-08-17] Muted-conversation channel.
//
// Per-conversation silencing CANNOT be done with `playSound: false` on the
// notification: from Android 8 the CHANNEL owns sound, vibration and heads-up
// behaviour, and a per-notification flag is ignored. So a muted conversation is
// posted to a second, quiet channel instead. Same content, same bundle, no
// sound and no heads-up banner — which is exactly WhatsApp's mute semantics
// (the message still arrives and still counts, it just doesn't shout).
//
// Distinct id also means the user can retune "muted" chats separately, and
// changing it can never reset their overrides on the main Messages channel.
const AndroidNotificationChannel _msgMutedChannel = AndroidNotificationChannel(
  'avatok_messages_muted', 'Muted chats',
  description: 'Messages from conversations you have muted',
  importance: Importance.low,
  playSound: false, enableVibration: false,
);

// [NOTIF-ACTIONS-1] Action ids carried back in NotificationResponse.actionId.
// The file already had this convention for calls ('callback', 'now_free_call').
const String _kActReply = 'notif_reply';
const String _kActRead = 'notif_read';
const String _kActMute = 'notif_mute';

// Fixed notification id for the app-update banner (distinct from message 8000 /
// group 8001 / missed-call 8002 / now-free 8003 / branded-incoming 8005 ids).
const int _kUpdateNotifId = 8006;
// Fixed notification id for the branded incoming-call FSI (distinct from the
// message 8000 / group 8001 / missed-call 8002 / now-free 8003 ids). One live
// incoming ring at a time, so a single reused id is correct.
const int _kBrandedIncomingNotifId = 8005;
// Marker inside the (JSON) notification payload identifying a branded-incoming
// full-screen intent, so the tap / cold-start / FSI-launch handlers can route it
// to IncomingBusinessCallScreen rather than the inbox.
const String _kBrandedIncomingPayloadKind = 'bizcall';

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
    await _local.initialize(
      const InitializationSettings(
        android: AndroidInitializationSettings(_kNotifIcon),
      ),
      // [NOTIF-ACTIONS-1] Reply / Mark as read / Mute pressed while the app is
      // dead. Registering it on BOTH initialize() call sites matters: whichever
      // isolate happens to have initialised the plugin owns the callback, and if
      // this one omitted it the actions would work only when the app was already
      // running — i.e. in exactly the case where the user did not need them.
      onDidReceiveBackgroundNotificationResponse: notificationActionBackground,
    );
    final android = _local
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    await android?.createNotificationChannel(_msgChannel);
    await android?.createNotificationChannel(_callsChannel);
    await android?.createNotificationChannel(_incomingCallChannel); // [AVACALL-INUI-2]
    await android?.createNotificationChannel(_updatesChannel); // [AVA-UPDATE-PUSH-1]
    await android?.createNotificationChannel(_msgMutedChannel); // [NOTIF-ACTIONS-1]
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
  // [NOTIF-STYLE-1] Report the KIND, never the raw payload. Since message
  // notifications became per-conversation their payload is `chat:<conv>`, and
  // sending that verbatim would put an unbounded set of conversation ids into a
  // PostHog property that until now held a handful of fixed strings — unusable
  // for grouping, and a needless identifier in analytics.
  final payloadKind = payload.contains(':') ? '${payload.split(':').first}:' : payload;
  Analytics.capture('push_notif_tapped', {'payload_kind': payloadKind});
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
  // [AVA-UPDATE-PUSH-1] Tapping the "Update available" banner (app was in the
  // background/terminated when the release push landed) brings us to the front
  // and runs a detection pass, which shows the in-app update dialog.
  if (payload == 'app_update') {
    navigatorKey.currentState?.popUntil((r) => r.isFirst);
    unawaited(UpdateService.onUpdatePush());
    return;
  }
  // [CALLREC-UX-1] Defect 4: `worker/src/routes/callrec.ts` has always pushed
  // `type: "call_recording"` with the conv id, but nothing on the client
  // referenced the recording screens — the bg handler fell through to
  // `_showIncoming`, which drops anything that isn't `type == 'call'`, so the
  // notification either never appeared or opened wherever the app happened to
  // be. Tap now lands on the Inbox thread holding the recording.
  if (payload.startsWith('callrec:')) {
    _clearBadge('callrec_notif_tap');
    unawaited(_openCallRecordingThread(payload.substring('callrec:'.length)));
    return;
  }
  // [NOTIF-STYLE-1] A tap on one CHILD of the message bundle. Each child is a
  // single conversation, so it must open THAT conversation — landing on the chat
  // list would make the whole per-chat stack pointless, since the user would
  // still have to find the thread by hand.
  //
  // The conv id has been in the FCM data since [PUSH-FG-BANNER-1]; it was simply
  // never put into the notification payload, so `_onNotifTap` had nothing to
  // route on and every tap fell through to popUntil(isFirst) below.
  if (payload.startsWith('chat:')) {
    _clearBadge('chat_notif_tap');
    final conv = payload.substring('chat:'.length);
    // Drop this thread from the shade log and take its row down — otherwise the
    // next message re-expands into messages already read.
    unawaited(_clearShadeThread(conv));
    unawaited(_openChatThread(conv));
    return;
  }
  // CALLFIX-R7: 'chat' payload opens inbox (main notification tap on missed-call or message).
  // This is also where a tap on the bundle SUMMARY lands, which is correct: the
  // summary spans several conversations, so the chat list is the honest
  // destination for it.
  // Callback action is handled separately in _handleMissedCallCallback.
  if (payload != 'chat') return;
  _clearBadge('chat_notif_tap');
  navigatorKey.currentState?.popUntil((r) => r.isFirst); // back to shell/chat list
}

/// [NOTIF-STYLE-1] Deep link for a tap on one conversation's message
/// notification. Same resolution strategy as [_openCallRecordingThread]: the
/// push carries only the conv id, and `InboxApi.threads()` is cache-backed so
/// this is usually instant. A miss still leaves the user on the chat list rather
/// than wherever the app happened to be.
Future<void> _openChatThread(String conv) async {
  final nav = navigatorKey.currentState;
  if (nav == null) return;
  nav.popUntil((r) => r.isFirst);
  if (conv.isEmpty) return;
  try {
    final threads = await InboxApi.threads();
    InboxThread? match;
    for (final t in threads) {
      if (t.conv == conv) {
        match = t;
        break;
      }
    }
    final found = match;
    if (found == null) {
      Analytics.capture('push_notif_open', {'ok': false, 'reason': 'no_thread', 'dest': 'thread'});
      return;
    }
    navigatorKey.currentState?.push(MaterialPageRoute<void>(
      builder: (_) => InboxThreadScreen(thread: found),
    ));
    // [NOTIF-STYLE-1] `dest:'thread'` is the ship-gate success value for the
    // deep link. The pre-fix behaviour would read dest:'home'.
    Analytics.capture('push_notif_open', {'ok': true, 'dest': 'thread'});
  } catch (e, st) {
    unawaited(Analytics.captureException(e, st,
        screen: 'push_chat_deeplink', handled: true));
  }
}

/// [CALLREC-UX-1] Deep link for a `type: 'call_recording'` notification tap:
/// open the Inbox thread that holds the recording.
///
/// The push carries only the conv id, so the thread object has to be resolved
/// (`InboxApi.threads()` is cache-backed, so this is usually instant). We stop
/// at the THREAD rather than pushing `CallRecordingDetailScreen` directly
/// because the detail screen needs the `InboxCard`, and the thread is the honest
/// landing place anyway: it shows the new recording plus everything else with
/// that person. A miss (thread not fetched yet, offline) still leaves the user
/// on the app's home rather than wherever they were.
Future<void> _openCallRecordingThread(String conv) async {
  final nav = navigatorKey.currentState;
  if (nav == null) return;
  nav.popUntil((r) => r.isFirst);
  if (conv.isEmpty) return;
  try {
    final threads = await InboxApi.threads();
    InboxThread? match;
    for (final t in threads) {
      if (t.conv == conv) {
        match = t;
        break;
      }
    }
    final found = match;
    if (found == null) {
      Analytics.capture('callrec_notif_open', {'ok': false, 'reason': 'no_thread'});
      return;
    }
    navigatorKey.currentState?.push(MaterialPageRoute<void>(
      builder: (_) => InboxThreadScreen(thread: found),
    ));
    Analytics.capture('callrec_notif_open', {'ok': true});
  } catch (e, st) {
    unawaited(Analytics.captureException(e, st,
        screen: 'push_callrec_deeplink', handled: true));
  }
}

/// [CALLREC-UX-1] Local banner for "Call recording saved" — the worker's
/// `type: 'call_recording'` push (worker/src/routes/callrec.ts). Payload
/// `callrec:<conv>` is what [_onNotifTap] routes on.
Future<void> _showCallRecordingNotif(Map<String, dynamic> d) async {
  final conv = (d['conv'] ?? '').toString();
  final who = (d['fromName'] ?? '').toString();
  final count = await _bumpBadge('call_recording');
  await _ensureLocalInit(); // bg isolate: plugin isn't init'd here otherwise → crash
  final body = who.isEmpty || who == 'AvaTOK'
      ? 'Your call recording was saved'
      : 'Your call with $who was saved';
  await _local.show(
    8007, // dedicated id — must not overwrite the message/missed-call banners
    'Call recording saved',
    body,
    NotificationDetails(
      android: AndroidNotificationDetails(
        _msgChannel.id, _msgChannel.name,
        channelDescription: _msgChannel.description,
        icon: _kNotifIcon, // [NOTIF-ICON-1]
        importance: Importance.defaultImportance,
        priority: Priority.defaultPriority,
        number: count,
        ticker: 'Call recording saved',
        category: AndroidNotificationCategory.status,
      ),
    ),
    payload: conv.isNotEmpty ? 'callrec:$conv' : 'chat',
  );
  await _bgTrack('push_shown', {'channel': 'messages', 'type': 'call_recording'});
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
        icon: _kNotifIcon, // [NOTIF-ICON-1]
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

/// [AVA-UPDATE-PUSH-1] "Update available" banner for a release push that arrived
/// while the app was BACKGROUND/terminated. Quiet channel (no sound/vibration).
/// Tapping it (payload 'app_update') resumes the app and runs the update flow via
/// [_onNotifTap]. Best-effort — a failure here never breaks the bg handler.
Future<void> _showUpdateNotif(Map<String, dynamic> d) async {
  final b = (d['build'] ?? '').toString();
  await _ensureLocalInit(); // bg isolate: plugin isn't init'd here otherwise → crash
  await _local.show(
    _kUpdateNotifId,
    'Update available',
    'A new version of AvaTOK is ready. Tap to update.',
    NotificationDetails(
      android: AndroidNotificationDetails(
        _updatesChannel.id, _updatesChannel.name,
        channelDescription: _updatesChannel.description,
        icon: _kNotifIcon, // [NOTIF-ICON-1]
        importance: Importance.defaultImportance, priority: Priority.defaultPriority,
        category: AndroidNotificationCategory.recommendation,
        onlyAlertOnce: true, // updating the banner for a newer build must not re-alert
        ticker: 'AvaTOK update available',
      ),
    ),
    payload: 'app_update',
  );
  await _bgTrack('app_update_push_bg', {'build': b});
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
    } else if (type == 'call_recording') {
      // [CALLREC-UX-1] Used to fall through to `_showIncoming`, which discards
      // anything that isn't `type == 'call'` — so this push did nothing at all.
      await _showCallRecordingNotif(d);
    } else if (type == 'app_update') {
      // [AVA-UPDATE-PUSH-1] A new build was published and the app is asleep — post
      // a quiet "Update available" banner; the tap resumes us and prompts to update.
      await _showUpdateNotif(d);
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
      // [CALL-REDUCER-1] Background isolate routes through the SAME reducer as
      // the foreground. It used to run its own abbreviated teardown here (it
      // forgot the ringtone fallback and the glare globals entirely), which is
      // why a call ended while the app was backgrounded could leave state
      // behind that only a restart cleared.
      await applyRingTransition(
        (d['callId'] ?? '').toString(),
        (d['status'] ?? '').toString(),
        seq: int.tryParse((d['seq'] ?? '').toString()),
        source: 'fcm_bg',
      );
    } else if (type == 'now_free' || type == 'call_now_free') {
      // [BUSY-CARD-1] A callee we asked to be notified about is now free →
      // surface the tap-to-call banner even when backgrounded/killed.
      await _showNowFreeNotif(d);
    } else {
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

/// A call-status that means ANY INCOMING RING on this device should stop.
///
/// [CALL-TERMINAL-BCAST-1 2026-08-01] `decline`/`declined` were missing here, so
/// a decline never ended the CallKit ring nor dismissed the branded full-screen
/// UI — on a second device of the same account the ring screen simply stayed up
/// (prod call avatok-f0c0ef5c). `decline_ava`/`decline_agent` ALSO belong here:
/// the callee is done ringing in both cases. They are deliberately NOT in
/// [_callerSessionTerminal] — see that doc.
///
/// This is the RING lifecycle, not the CALL lifecycle. Keep the two apart.
bool _terminalCallStatus(String s) =>
    s == 'cancel' || s == 'ended' || s == 'missed' || s == 'no-answer' ||
    s == 'bye' || s == 'hangup' ||
    s == 'decline' || s == 'declined' ||
    s == 'decline_ava' || s == 'decline_agent';

/// A call-status that means the CALLER's own CallSession is over.
///
/// [CALL-TERMINAL-BCAST-1] Deliberately EXCLUDES `decline_ava`/`decline_agent`:
/// those mean "the callee handed me off", and the caller's session must stay
/// alive long enough for `CallSession._handoffToAva` to take the leg. Treating
/// them as terminal here would kill the receptionist before it ever connected.
// ignore: unused_element
bool _callerSessionTerminal(String s) =>
    s == 'cancel' || s == 'ended' || s == 'missed' || s == 'no-answer' ||
    s == 'bye' || s == 'hangup' || s == 'decline' || s == 'declined';

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

// [CALL-ONE-LANE-1 2026-08-15] A foreground Dart isolate and the FCM
// background isolate do not share heap state. Without a device-level marker,
// a late copy of the same invite can recreate the native ring after Accept:
// the main isolate has already closed CallKit, while the background isolate
// still believes the call is new. This is deliberately a short-lived,
// device-level accept lease, not call history or account state.
const String _kAcceptedIncomingCallGlobal = 'avatok_accepted_incoming_call_v1';
const int _kAcceptedIncomingCallTtlMs = 5 * 60 * 1000;

Future<void> _markIncomingCallAcceptedDurably(String callId) async {
  if (callId.isEmpty) return;
  try {
    await DiskCache.writeGlobal(_kAcceptedIncomingCallGlobal, jsonEncode({
      'call_id': callId,
      'at_ms': DateTime.now().millisecondsSinceEpoch,
    }));
  } catch (_) {/* the in-memory gate remains the fast-path authority */}
}

Future<bool> _wasIncomingCallAcceptedDurably(String callId) async {
  if (callId.isEmpty) return false;
  try {
    final raw = await DiskCache.readGlobal(_kAcceptedIncomingCallGlobal);
    if (raw == null || raw.isEmpty) return false;
    final value = jsonDecode(raw);
    if (value is! Map) return false;
    final acceptedId = (value['call_id'] ?? '').toString();
    final atMs = int.tryParse((value['at_ms'] ?? '').toString());
    if (acceptedId != callId || atMs == null) return false;
    return DateTime.now().millisecondsSinceEpoch - atMs <
        _kAcceptedIncomingCallTtlMs;
  } catch (_) {
    return false;
  }
}

void _noteTerminalCall(String callId) {
  if (callId.isEmpty) return;
  final now = DateTime.now().millisecondsSinceEpoch;
  _terminalCallAt[callId] = now;
  // Opportunistic prune so the map can't grow unbounded across a long session.
  if (_terminalCallAt.length > 64) {
    _terminalCallAt.removeWhere((_, ts) => now - ts > _kTerminalCallTtlMs);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// [CALL-REDUCER-1 2026-08-01] THE SINGLE AUTHORITATIVE RING-STATE REDUCER
// ═══════════════════════════════════════════════════════════════════════════
//
// Spec: Specs/CALL-OUTCOMES-FROZEN-2026-08-01.md — "the piece that cannot be
// deferred".
//
// WHY THIS EXISTS. Every recurrence of the stale-call-UI bug had the same
// shape: the ringing -> not-ringing transition was implemented INDEPENDENTLY in
// seven places — the foreground FCM handler, the background isolate handler, the
// CallKit event listener, the branded incoming screen's five button handlers,
// the WS ring path, CallSession, and the notification layer. Each one
// remembered a slightly different subset of {stop ringtone, stop vibration,
// cancel notification, dismiss full-screen UI, end CallKit, clear glare
// globals}. Fixing one never fixed the others, which is why "the screen didn't
// go away" kept coming back wearing a different hat.
//
// From now on there is exactly ONE cleanup path and every surface routes into
// it. Button handlers may ONLY: disable repeated input, send a command,
// optimistically anticipate the transition, and let this reducer clean up.
// If you are about to write `FlutterCallkitIncoming.endCall` or
// `_dismissBrandedFsi` in a new place — don't. Call the reducer.
//
// It is deliberately in push_service.dart rather than its own file because
// every ring-surface primitive it drives (the CallKit bridge, the FSI
// notification id, the ringtone fallback, the glare globals) is private to this
// library. Splitting it out would mean exporting six internals and inviting
// exactly the duplication this replaces.

/// Ordering + idempotency state per callId. Server transitions carry a
/// monotonic sequence; anything older than what we have already applied is a
/// late/replayed delivery and must be dropped, not re-applied.
class _RingTransition {
  final int seq;
  final int appliedAtMs;
  const _RingTransition(this.seq, this.appliedAtMs);
}

final Map<String, _RingTransition> _ringApplied = <String, _RingTransition>{};

/// [CALL-CALLEE-SEQ-1 2026-08-03] callId → the CallRoom `transition_sequence`
/// carried by the RING, which is the ordering floor for that call.
///
/// Per-isolate, like every other map in this file: the FCM background isolate
/// has its own Dart heap, so it keeps its own copy seeded from its own copy of
/// the ring. That is correct — both isolates see the same ring and therefore
/// derive the same floor, which is precisely what a shared *server* sequence
/// buys that a local counter never could.
final Map<String, int> _ringBaselineSeq = <String, int>{};

/// Record the ring's authoritative sequence. Bounded the same way as
/// [_ringApplied]: a call whose ring is older than the terminal TTL can no
/// longer receive a transition worth ordering.
void _noteRingSequence(String callId, int? seq) {
  if (callId.isEmpty || seq == null) return;
  // Keep the FIRST sequence seen for a call. The WS ring and the FCM ring are
  // the same transition arriving twice; the later copy must not raise the floor
  // above a transition that legitimately landed in between them.
  _ringBaselineSeq.putIfAbsent(callId, () => seq);
  if (_ringBaselineSeq.length > 64) {
    final live = _ringApplied.keys.toSet()..add(callId);
    _ringBaselineSeq.removeWhere((k, _) => !live.contains(k));
  }
}

/// Android OEMs do not agree on which CallKit event is emitted by a
/// programmatic `endCall`. Some Motorola builds report `actionCallDecline`, the
/// same event used for a human tapping Decline. Without this guard, ending the
/// native ring for `decline_ava` immediately fed `_declineRouting` and raced a
/// real `decline_call` against `handoff_to_receptionist`.
final CallTtlGate _programmaticCallkitEnd =
    CallTtlGate(ttlMs: _kTerminalCallTtlMs);

bool _wasProgrammaticCallkitEnd(String callId) =>
    _programmaticCallkitEnd.contains(callId);

/// [CALL-REL-R4-B 2026-08-03] How long after the last `resumed` a `paused` app
/// is still treated as being in front. Sized for the Android FSI-activity launch
/// (tens of ms in practice); deliberately far shorter than a user actually
/// leaving the app.
const int _kAppFrontGraceMs = 1500;

/// Verification delay for the OS-ring fallback. Long enough for the branded
/// route to have been pushed and the activity to have settled, short enough that
/// a fallback ring is still a ring and not a missed call.
const int _kOsRingFallbackDelayMs = 900;

/// [CALL-REL-R4-B] Tracks when this app was last actually in front.
///
/// `WidgetsBinding.instance.lifecycleState` is a POINT reading, and at ring time
/// it lies: while Android launches CallKit's own full-screen-intent activity
/// over a perfectly open app, MainActivity reports `paused`. Prod call
/// `avatok-cb1618e6` rang with `lifecycle=paused` and consequently registered
/// BOTH surfaces. Knowing how long ago we were resumed is what separates "the
/// ring is launching over us" from "the user left".
class _AppFrontTracker with WidgetsBindingObserver {
  _AppFrontTracker._();
  static final _AppFrontTracker I = _AppFrontTracker._();

  int _lastResumedAtMs = 0;
  bool _registered = false;

  /// Idempotent. No-ops in the FCM background isolate, which has no binding —
  /// and correctly so: an isolate with no UI is never "in front".
  void ensureRegistered() {
    if (_registered) return;
    try {
      WidgetsBinding.instance.addObserver(this);
      _registered = true;
      if (WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) {
        _lastResumedAtMs = DateTime.now().millisecondsSinceEpoch;
      }
    } catch (_) {/* no binding (bg isolate) — stays unregistered, reports "never" */}
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _lastResumedAtMs = DateTime.now().millisecondsSinceEpoch;
    }
  }

  /// Milliseconds since the app was last resumed. Returns a very large number
  /// when we have never seen a resume, so every grace comparison fails closed.
  int get msSinceResumed => _lastResumedAtMs == 0
      ? 1 << 30
      : DateTime.now().millisecondsSinceEpoch - _lastResumedAtMs;
}

/// [CALL-REL-R4-B] Why we believe the app is in front, or null if it is not.
///
/// Returning a REASON rather than a bool is deliberate: it is what lets the
/// suppression telemetry distinguish the safe strict case from a relaxed guess,
/// and it is what decides whether the verification fallback gets armed.
String? _resolveAppFrontReason(String lifecycle) {
  if (lifecycle == 'resumed') return 'resumed';
  if (!RemoteConfig.foregroundRingDetectionV2) return null;
  // No navigator means nothing to show the branded screen on, so the app cannot
  // own the ring no matter what the lifecycle says. This also excludes the FCM
  // background isolate, whose sentinel is 'no_binding'.
  if (navigatorKey.currentState == null) return null;
  // 'inactive' is the transition state while another activity (ours or the
  // system's) takes focus. On Android it is what a foregrounded app reports
  // mid-hand-off, and it is where CallKit's FSI launch passes through.
  if (lifecycle == 'inactive') return 'inactive_transient';
  // 'paused' immediately after a resume is the FSI-launch window specifically.
  // Anything older than the grace is a user who genuinely left.
  if (lifecycle == 'paused' &&
      _AppFrontTracker.I.msSinceResumed <= _kAppFrontGraceMs) {
    return 'paused_within_grace';
  }
  return null;
}

/// [CALL-REL-R4-B] Safety net for a RELAXED foreground guess.
///
/// Suppressing the OS ring on `inactive`/`paused` is a bet that the branded
/// screen is about to own the surface. If that bet is wrong the user gets no
/// ring at all — strictly worse than the double-surface bug we are fixing. So:
/// wait briefly, re-read the lifecycle, and register CallKit after all if the
/// app did not actually come to front.
///
/// Bails out if the ring stopped mattering in the meantime — the call went
/// terminal, or the user already accepted (`_programmaticCallkitEnd` is stamped
/// by `_finishAcceptedRing` before it dismisses the ring). Posting an incoming
/// -call notification for an accepted call would recreate the exact symptom this
/// change exists to remove.
Future<void> _verifyForegroundRingOrFallback({
  required String callId,
  required CallKitParams params,
  required String route,
  required String? frontReason,
}) async {
  await Future<void>.delayed(
      const Duration(milliseconds: _kOsRingFallbackDelayMs));
  if (callId.isNotEmpty &&
      (PushService.wasCallTerminated(callId) ||
          _wasProgrammaticCallkitEnd(callId))) {
    return;
  }
  String now = 'no_binding';
  try {
    now = WidgetsBinding.instance.lifecycleState?.name ?? 'none';
  } catch (_) {/* binding vanished — treat as not-in-front and fall back */}
  if (now == 'resumed') return; // the guess was right; branded screen owns it.
  try {
    await FlutterCallkitIncoming.showCallkitIncoming(params);
    // CallKit owns the ringtone again, so hand ours back rather than ringing twice.
    unawaited(_stopRingtoneFallback(callId));
    Analytics.capture('call_os_ring_fallback_registered', {
      'call_id': callId,
      'route': route,
      'front_reason': frontReason ?? 'none',
      'lifecycle_after': now,
      'delay_ms': _kOsRingFallbackDelayMs,
    });
  } catch (e) {
    Analytics.capture('call_os_ring_fallback_failed', {
      'call_id': callId,
      'route': route,
      'error': e.toString(),
    });
  }
}

/// Close native/local ring surfaces after a HUMAN ACCEPT without manufacturing
/// a terminal call outcome. Some Android/OEM CallKit implementations emit
/// `actionCallDecline` synchronously from a programmatic `endCall()`, so mark
/// the bridge operation before crossing it. Every platform await is time-boxed:
/// an accepted call must continue opening even if an OEM call-service bridge is
/// wedged.
Future<void> _finishAcceptedRing(String callId) async {
  if (callId.isEmpty) return;
  _programmaticCallkitEnd.mark(callId);
  try {
    await FlutterCallkitIncoming.endCall(callId)
        .timeout(const Duration(milliseconds: 1200));
  } on TimeoutException {
    Analytics.capture('call_accept_native_cleanup_timeout', {
      'call_id': callId,
      'stage': 'end_call',
    });
  } catch (e) {
    Analytics.capture('call_accept_native_cleanup_failed', {
      'call_id': callId,
      'stage': 'end_call',
      'error': e.toString(),
    });
  }
  try {
    await _dismissBrandedFsi().timeout(const Duration(milliseconds: 800));
  } catch (_) {/* best-effort */}
  try {
    await _stopRingtoneFallback(callId)
        .timeout(const Duration(milliseconds: 800));
  } catch (_) {/* best-effort */}
  if (gIncomingRingingCallId == callId) {
    gIncomingRingingFrom = null;
    gIncomingRingingCallId = null;
  }
}

/// The authoritative ring-state reducer.
///
/// Call this for EVERY event that ends a callee's ring, from any source:
/// FCM foreground, FCM background isolate, the CallRoom DO socket, a local
/// button tap, CallKit, or a ring timeout.
///
/// [status] is the authoritative call status (`decline`, `cancel`, `bye`, …).
/// [seq] is the server's monotonic `transition_sequence` when the transition
/// came from the server; pass `null` for a purely local optimistic tap, which
/// is applied immediately but never blocks a later server transition.
/// [source] is telemetry only — it must NEVER change behaviour, or we are back
/// to per-source logic.
///
/// Idempotent: applying the same transition twice is a no-op. Safe to call
/// from a background isolate (every step is individually guarded).
Future<void> applyRingTransition(
  String callId,
  String status, {
  int? seq,
  required String source,
}) async {
  if (callId.isEmpty) return;
  if (!_terminalCallStatus(status)) return; // not a ring-ending transition

  final prior = _ringApplied[callId];
  // [CALL-CALLEE-SEQ-1] The ring's own sequence is the floor for this call. A
  // server transition at or below it predates the ring we are showing, so it is
  // a replay (at-least-once queue, socket reconnect, the other Dart isolate) and
  // must not tear down a live ring. Checked BEFORE `prior` so it applies to the
  // very first transition too — which is exactly the one that had no floor.
  final baseline = _ringBaselineSeq[callId];
  if (seq != null && baseline != null && seq <= baseline) {
    Analytics.capture('call_transition_dropped', {
      'call_id': callId, 'status': status, 'source': source,
      'seq': seq, 'ring_seq': baseline, 'reason': 'stale_vs_ring',
    });
    return;
  }
  if (prior != null) {
    // Out-of-order or duplicate server transition → drop. This is what makes a
    // late FCM redelivery, a socket reconnect replay and a duplicate queue
    // message harmless instead of a source of UI flicker.
    if (seq != null && seq <= prior.seq) {
      Analytics.capture('call_transition_dropped', {
        'call_id': callId, 'status': status, 'source': source,
        'seq': seq, 'applied_seq': prior.seq, 'reason': 'stale_seq',
      });
      return;
    }
    // Already cleaned up locally and this carries no newer sequence → nothing
    // left to do. Still cheap to return early rather than re-run teardown.
    if (seq == null) return;
  }
  // A local tap carries no sequence — it is an INTENT, not an authoritative
  // transition. Record the ring's floor rather than 0 so a later stale server
  // transition still loses to it.
  _ringApplied[callId] = _RingTransition(
    seq ?? (prior?.seq ?? baseline ?? 0), DateTime.now().millisecondsSinceEpoch);
  if (_ringApplied.length > 64) {
    final cutoff = DateTime.now().millisecondsSinceEpoch - _kTerminalCallTtlMs;
    _ringApplied.removeWhere((_, t) => t.appliedAtMs < cutoff);
  }

  // ── THE ONE CLEANUP PATH ──────────────────────────────────────────────────
  // Order matters only in that the durable marker goes FIRST: an accept racing
  // this teardown must find the terminal marker even if a later step throws.
  _noteTerminalCall(callId);

  // [CALL-PREWARM-1 2026-08-16] This function only runs for a ring that ended
  // WITHOUT being accepted (`_terminalCallStatus` gates entry above) — decline,
  // caller cancel, timeout, missed. Tear down any pre-warmed SFU seat for this
  // call; `discard` itself is a no-op if nothing was ever warmed. Fire-and-
  // forget and exception-proof by construction.
  try {
    unawaited(CallPrewarm.instance.discard(callId, status));
  } catch (_) {/* teardown must never affect the ring reducer */}

  // Every step is independently guarded — one failing surface must never
  // prevent the others from being torn down. That was another way the old
  // duplicated code left a screen up: an exception halfway through.
  // Set this BEFORE crossing the platform bridge. On affected Motorola builds
  // the synthetic actionCallDecline can arrive synchronously from endCall().
  _programmaticCallkitEnd.mark(callId);
  try { await FlutterCallkitIncoming.endCall(callId); } catch (_) {/* already ended */}
  try { await _dismissBrandedFsi(); } catch (_) {/* no FSI posted */}
  try { await _stopRingtoneFallback(callId); } catch (_) {/* not playing */}
  if (gIncomingRingingCallId == callId) {
    gIncomingRingingFrom = null;
    gIncomingRingingCallId = null;
  }

  // A terminal transition closes the short device-level accept lease too.
  // This prevents a later, legitimate call from being mistaken for the call
  // that was just answered while retaining protection against late duplicates.
  try {
    final raw = await DiskCache.readGlobal(_kAcceptedIncomingCallGlobal);
    if (raw != null && raw.isNotEmpty) {
      final value = jsonDecode(raw);
      if (value is Map && (value['call_id'] ?? '').toString() == callId) {
        await DiskCache.writeGlobal(_kAcceptedIncomingCallGlobal, '');
      }
    }
  } catch (_) {/* durable cleanup is best-effort */}

  // [CALL-STALE-TAP-1 2026-08-03] Drop any native tap still queued for this
  // call. MainActivity holds an un-drained tap in a companion object for the
  // life of the process and only ever cleared it on a successful drain, so a tap
  // for a call that has since ended could be drained on a LATER launch and route
  // the user into a ring surface for a finished call. This is the one reducer
  // every ring-ending path funnels through, so it is the right place to clear.
  try {
    await const MethodChannel('avatok/incoming_call_tap')
        .invokeMethod('clearPending', {'callId': callId});
  } catch (_) {/* older build without the handler, or not Android */}

  // [PIV-2 2026-08-02] Tell every in-app ring SURFACE the ring is over. The
  // steps above tear down the surfaces this file owns (CallKit, the FSI banner,
  // the ringtone, the glare globals) but the branded full-screen
  // IncomingBusinessCallScreen is a Flutter route this file cannot pop, so
  // without this it stayed up after a decline taken on the CallKit
  // notification. Broadcast controllers drop events when nothing is listening,
  // so this is safe in the FCM background isolate too.
  ringEndedBus.add((callId: callId, status: status));

  Analytics.capture('call_ring_transition_applied', {
    'call_id': callId,
    'status': status,
    'source': source,
    'seq': seq ?? -1, // -1 = local optimistic tap, no server sequence yet
  });
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
          icon: _kNotifIcon, // [NOTIF-ICON-1]
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

// ── [NOTIF-STYLE-1 2026-08-17] Per-conversation message stacking ────────────
//
// THE BUG THIS EXISTS TO FIX. Every chat message was posted under the single
// hardcoded notification id 8000. Android treats "same id" as "same
// notification", so a message from a second person did not stack beside the
// first — it REPLACED it, in place. The shade could physically never hold more
// than one AvaTOK chat row, no matter how many people wrote. That is why AvaTOK
// had no "3 messages from 3 chats" bundle: not a missing feature, an id.
//
// The shape below is the one WhatsApp uses and the one the missed-call code in
// this same file has used correctly since [AVANOTIF-VM-1]:
//   • one notification per CONVERSATION, on a stable id derived from the conv
//   • all of them tagged with a shared groupKey, so Android bundles them
//   • one extra notification carrying setAsGroupSummary, which is the row that
//     reads "N messages from M chats" and owns the expand chevron
//   • each child styled with MessagingStyle so it expands on its OWN chevron to
//     that chat's unread messages, with the sender's photo — the owner's
//     "expand individual messages without opening the app"
const String _kMsgGroupKey = 'avatok_messages_group';
// 8004 was the one free slot in the 8000-8007 fixed block (8000 message,
// 8001 group invite, 8002 missed-call summary, 8003 now-free, 8005 branded
// incoming, 8006 update, 8007 call recording).
const int _kMsgSummaryId = 8004;
// GLOBAL disk key, keyed by account id INSIDE the blob — same pattern as
// _kMissedCallsLogKey. It has to be global because the background isolate has no
// AccountScope loaded, so a scoped key would be unreadable exactly when a push
// arrives; the account id is resolved by hand in _shadeAccountId() and used as
// the top-level map key, which keeps the shared-phone isolation the rulebook
// requires without depending on AccountScope being live.
const String _kMsgThreadsKey = 'push_msg_threads_v1';
// Caps. The shade cannot usefully show more than a handful, and this blob is
// re-read and re-written on every single incoming message, so it must stay small.
const int _kMaxShadeThreads = 6;
const int _kMaxShadeMsgs = 8;

/// Stable per-conversation notification id, in 8900..9499.
///
/// Deliberately clear of every other id this file uses: 8000-8007 fixed,
/// 8010 the no-key missed call, and 8100-8899 the per-caller missed-call range
/// ([_missedCallNotifId]). A collision would mean a chat message silently
/// overwriting a missed call, which is the same class of bug as the one being
/// fixed here.
///
/// `hashCode` is not stable across app RESTARTS for some Dart types, but it IS
/// stable for String within a process, and a notification only has to keep its
/// identity for as long as it is on screen. A restart at worst posts a second
/// row for the same chat; the store below is cleared on tap, so it self-heals.
int _msgNotifId(String conv) =>
    conv.isEmpty ? 8000 : 8900 + (conv.hashCode.abs() % 600);

/// The account these notifications belong to. [AccountScope] is normally null in
/// the background isolate, so fall back to the device-level active-account key.
Future<String> _shadeAccountId() async {
  var id = AccountScope.id ?? '';
  if (id.isEmpty) id = (await DiskCache.readGlobal(_kActiveAccountKey)) ?? '';
  return id;
}

Future<Map<String, dynamic>> _readShadeBlob() async {
  final raw = await DiskCache.readGlobal(_kMsgThreadsKey);
  if (raw == null || raw.isEmpty) return <String, dynamic>{};
  try {
    return jsonDecode(raw) as Map<String, dynamic>;
  } catch (_) {
    return <String, dynamic>{}; // corrupt blob → start fresh, never throw at a push
  }
}

int _asMs(Object? v) => (v is num) ? v.toInt() : 0;

/// The result of folding one incoming message into the shade log — computed but
/// NOT yet written. See [_buildShadeUpdate] for why the write is deferred.
class _ShadeUpdate {
  _ShadeUpdate(this.all, this.byConv, this.evicted);

  /// The whole on-disk blob, ready to persist.
  final Map<String, dynamic> all;

  /// Just this account's conversations, for rendering.
  final Map<String, dynamic> byConv;

  /// Conversations dropped by [_kMaxShadeThreads]. Their notifications must be
  /// cancelled, or they linger in the bundle as children the summary no longer
  /// counts and nothing will ever update again.
  final List<String> evicted;
}

/// Fold one message into its conversation's shade log and return the result.
///
/// PURE with respect to disk: it reads, but it does NOT write. The caller
/// persists only AFTER the notification has actually rendered.
///
/// That ordering is deliberate. Writing first means that if the render then
/// throws, the message is already recorded as "shown" while the user is looking
/// at the legacy fallback banner — and the next push re-renders it inside the
/// stacked card, so one message appears twice on screen.
///
/// Returns NULL when this message is a DUPLICATE and nothing should change.
/// The duplicate check is not defensive padding: FCM is at-least-once and this
/// path is reachable from BOTH the background isolate and the foreground
/// handler, so the same push genuinely does arrive twice. When `mid` is absent
/// (a pre-[NOTIF-PAYLOAD-1] server) there is nothing to compare and duplicates
/// can still slip through — accepted, because the alternative is matching on
/// message text, which would swallow someone legitimately sending "ok" twice.
Future<_ShadeUpdate?> _buildShadeUpdate({
  required String acct,
  required String conv,
  required String mid,
  required String who,
  required String text,
  required int ts,
  required bool isGroup,
  required String groupName,
  required String avatarPath,
  // [NOTIF-ACTIONS-1] Everything a notification ACTION needs in order to act
  // without the app. Stored WITH the thread because the action handler runs in a
  // bare background isolate that has only the notification's payload
  // ('chat:<conv>') to go on — it cannot re-derive the peer uid or the local
  // conversation key from the conv id alone.
  //   peerUid  → the `to` field of POST /api/msg/send for a DM
  //   convKey  → the LOCAL key ('1:<peerUid>' / 'g:<gid>') that ReadStateStore
  //              and ChatFlagsStore are keyed on, which is a different namespace
  //              from the server conv id
  String peerUid = '',
  String convKey = '',
}) async {
  final all = await _readShadeBlob();
  var byConv = Map<String, dynamic>.from((all[acct] as Map?) ?? const <String, dynamic>{});
  // Drop conversations the user has already dismissed from the shade by hand.
  byConv = await _pruneDismissed(byConv, keep: conv);
  final t = Map<String, dynamic>.from((byConv[conv] as Map?) ?? const <String, dynamic>{});
  final msgs = ((t['m'] as List?) ?? const <dynamic>[])
      .map((e) => Map<String, dynamic>.from(e as Map))
      .toList();
  if (mid.isNotEmpty && msgs.any((m) => (m['id'] ?? '').toString() == mid)) {
    return null; // already in the shade — re-rendering would duplicate the line
  }
  msgs.add({'id': mid, 'who': who, 'text': text, 'ts': ts, 'ava': avatarPath});
  msgs.sort((a, b) => _asMs(a['ts']).compareTo(_asMs(b['ts'])));
  if (msgs.length > _kMaxShadeMsgs) {
    msgs.removeRange(0, msgs.length - _kMaxShadeMsgs); // keep the NEWEST
  }
  t['m'] = msgs;
  t['g'] = isGroup;
  if (groupName.isNotEmpty) t['n'] = groupName;
  if (who.isNotEmpty) t['who'] = who;          // [NOTIF-ACTIONS-1] title when redrawing
  if (peerUid.isNotEmpty) t['to'] = peerUid;   // [NOTIF-ACTIONS-1]
  if (convKey.isNotEmpty) t['k'] = convKey;    // [NOTIF-ACTIONS-1]
  t['last'] = ts;
  // [NOTIF-ACTIONS-1] Is this conversation muted? Read from the SAME store the
  // in-app Mute switch writes (ChatFlagsStore, account-scoped 'avatok_chatflags'),
  // so the two cannot disagree. Until now nothing on the push path consulted it
  // at all — mute was a bell-slash icon in the chat list and literally nothing
  // else, on either the client or the server.
  if (convKey.isNotEmpty) {
    try {
      final flags = await ChatFlagsStore().load();
      t['mute'] = (flags['muted'] ?? const <String>{}).contains(convKey);
    } catch (_) {/* unknown → treat as unmuted, i.e. today's behaviour */}
  }
  byConv[conv] = t;
  final evicted = <String>[];
  if (byConv.length > _kMaxShadeThreads) {
    final keys = byConv.keys.toList()
      ..sort((a, b) => _asMs((byConv[b] as Map)['last'])
          .compareTo(_asMs((byConv[a] as Map)['last'])));
    for (final k in keys.skip(_kMaxShadeThreads)) {
      byConv.remove(k);
      evicted.add(k);
    }
  }
  all[acct] = byConv;
  return _ShadeUpdate(all, byConv, evicted);
}

Future<void> _persistShade(Map<String, dynamic> all) =>
    DiskCache.writeGlobal(_kMsgThreadsKey, jsonEncode(all));

/// Drop conversations whose notification is no longer on screen.
///
/// The store and the shade can drift apart, because the user can dismiss the
/// bundle (or the phone can reboot) without telling us. Nothing would then
/// remove those entries, so the summary would go on reporting "7 messages from 3
/// chats" over a bundle holding one child, and the stale messages would
/// re-appear inside the next expanded card.
///
/// [keep] is the conversation currently being rendered — its notification does
/// not exist yet, so it must be exempt or it would prune itself.
///
/// Entirely best-effort: `getActiveNotifications` needs API 23+ and can throw on
/// OEM skins. On any failure the map is returned untouched, which is simply
/// today's behaviour.
Future<Map<String, dynamic>> _pruneDismissed(
  Map<String, dynamic> byConv, {
  required String keep,
}) async {
  try {
    if (byConv.length <= 1) return byConv;
    final android = _local
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    if (android == null) return byConv;
    final active = await android.getActiveNotifications();
    if (active.isEmpty) return byConv; // treat "can't tell" as "don't prune"
    final liveIds = active.map((n) => n.id).whereType<int>().toSet();
    final out = Map<String, dynamic>.from(byConv);
    for (final k in byConv.keys) {
      if (k == keep) continue;
      if (!liveIds.contains(_msgNotifId(k))) out.remove(k);
    }
    return out;
  } catch (_) {
    return byConv;
  }
}

/// Forget one conversation's shade log and take its notification down. Called
/// when the user taps into that thread — otherwise the next message would
/// re-expand into messages the user has already read.
Future<void> _clearShadeThread(String conv) async {
  try {
    final acct = await _shadeAccountId();
    if (acct.isEmpty || conv.isEmpty) return;
    final all = await _readShadeBlob();
    final byConv = Map<String, dynamic>.from((all[acct] as Map?) ?? const <String, dynamic>{});
    byConv.remove(conv);
    all[acct] = byConv;
    await DiskCache.writeGlobal(_kMsgThreadsKey, jsonEncode(all));
    await _ensureLocalInit();
    await _local.cancel(_msgNotifId(conv));
    // Android leaves an EMPTY bundle behind if the summary outlives its last
    // child, so the summary has to be taken down or re-counted every time a
    // child goes away.
    await _renderShadeSummary(byConv);
  } catch (_) {/* cosmetic — never let shade bookkeeping break a tap */}
}

/// The sender's photo, on disk, for the MessagingStyle `Person`.
///
/// Keyed on the server's `senderAvatarVersion` rather than the URL, matching the
/// call path's `avatar:{uid}:{version}` contract: CDN transforms and query
/// strings churn while the image does not, so URL-keyed caching re-downloads the
/// same face forever. Returns '' on any failure and the notification simply
/// renders without a photo.
Future<String> _shadeAvatarPath(String url, String version) async {
  if (url.isEmpty) return '';
  try {
    final f = await AvatarCache.getAny(
      url, 128,
      cacheKey: version.isEmpty ? null : 'notifava:$version',
    );
    return f?.path ?? '';
  } catch (_) {
    return '';
  }
}

/// (Re)post the bundle summary — the row that reads "3 messages from 3 chats"
/// and owns the expand chevron in the owner's screenshot.
///
/// Only posted at TWO OR MORE conversations. With a single child Android already
/// shows that child on its own, and a summary over one item renders as a
/// duplicate row; below the threshold the summary is cancelled instead.
Future<void> _renderShadeSummary(Map<String, dynamic> byConv) async {
  try {
    await _ensureLocalInit();
    final entries = byConv.entries.toList()
      ..sort((a, b) => _asMs((b.value as Map)['last'])
          .compareTo(_asMs((a.value as Map)['last'])));
    final lines = <String>[];
    var total = 0;
    for (final e in entries) {
      final t = e.value as Map;
      final msgs = (t['m'] as List?) ?? const [];
      if (msgs.isEmpty) continue;
      total += msgs.length;
      final last = Map<String, dynamic>.from(msgs.last as Map);
      final gname = (t['n'] ?? '').toString();
      final who = (last['who'] ?? '').toString();
      // Group → "AvaGlobal  Satish: yes sounds good". DM → "Satish  yes sounds good".
      final label = gname.isNotEmpty ? gname : who;
      final body = gname.isNotEmpty && who.isNotEmpty
          ? '$who: ${(last['text'] ?? '').toString()}'
          : (last['text'] ?? '').toString();
      lines.add('$label  $body');
    }
    final chats = lines.length;
    if (chats < 2) {
      await _local.cancel(_kMsgSummaryId);
      return;
    }
    final headline = '$total ${total == 1 ? 'message' : 'messages'} '
        'from $chats ${chats == 1 ? 'chat' : 'chats'}';
    await _local.show(
      _kMsgSummaryId,
      'AvaTOK',
      headline,
      NotificationDetails(
        android: AndroidNotificationDetails(
          _msgChannel.id, _msgChannel.name,
          channelDescription: _msgChannel.description,
          icon: _kNotifIcon, // [NOTIF-ICON-1]
          importance: Importance.high, priority: Priority.high,
          groupKey: _kMsgGroupKey,
          setAsGroupSummary: true,
          category: AndroidNotificationCategory.message,
          // The children already alerted. Without this the summary re-rings on
          // every message in an active group — the same sound twice per message.
          onlyAlertOnce: true,
          styleInformation: InboxStyleInformation(
            lines, contentTitle: headline, summaryText: 'AvaTOK',
          ),
        ),
      ),
      payload: 'chat',
    );
    await _track('push_summary_shown', {
      'chats': chats,
      'messages': total,
      'path': BadgeService.inBackgroundIsolate ? 'background' : 'foreground',
    });
  } catch (_) {/* cosmetic — the per-chat children are already on screen */}
}

/// [NOTIF-STYLE-1 / NOTIF-ACTIONS-1] Draw (or redraw) ONE conversation's
/// notification: a MessagingStyle card carrying that chat's unread messages,
/// bundled under the shared message group, with Reply / Mark as read / Mute.
///
/// Extracted from [_showStackedMessageNotif] so the reply action can redraw the
/// SAME card with the sent message appended — WhatsApp's behaviour — rather
/// than a near-copy of this logic slowly drifting away from it.
///
/// Returns false if there was nothing to draw.
Future<bool> _renderConvNotification({
  required String conv,
  required Map<String, dynamic> byConv,
  required String fallbackTitle,
  required int count,
  required String ticker,
}) async {
  final t = Map<String, dynamic>.from((byConv[conv] as Map?) ?? const <String, dynamic>{});
  final msgs = ((t['m'] as List?) ?? const <dynamic>[])
      .map((e) => Map<String, dynamic>.from(e as Map))
      .toList();
  if (msgs.isEmpty) return false;
  final isGroup = t['g'] == true;
  final groupName = (t['n'] ?? '').toString();
  final muted = t['mute'] == true;

  // The first positional Person of a MessagingStyle is the DEVICE OWNER — the
  // "you" that outgoing messages are attributed to. It is not the sender.
  // Getting this backwards makes Android label every incoming line as the user.
  const me = Person(name: 'You', key: 'self', important: true);
  final style = MessagingStyleInformation(
    me,
    // Only a GROUP gets a conversation title; on a 1:1 Android already shows
    // the other person's name and a title would duplicate it.
    conversationTitle: isGroup && groupName.isNotEmpty ? groupName : null,
    groupConversation: isGroup,
    messages: [
      for (final m in msgs)
        Message(
          (m['text'] ?? '').toString(),
          DateTime.fromMillisecondsSinceEpoch(_asMs(m['ts'])),
          // A message with NO person is attributed to the style's own person,
          // i.e. to the user — which is how a reply sent from the shade renders
          // on the right-hand side of the conversation.
          (m['self'] == true)
              ? null
              : Person(
                  name: (m['who'] ?? '').toString(),
                  // A stable key per sender is what lets Android collapse
                  // consecutive messages from one person under a single photo,
                  // instead of repeating the avatar on every line.
                  key: (m['who'] ?? '').toString(),
                  icon: (m['ava'] ?? '').toString().isEmpty
                      ? null
                      : BitmapFilePathAndroidIcon((m['ava']).toString()),
                ),
        ),
    ],
  );

  // A muted conversation goes to the quiet CHANNEL, not to this channel with
  // sound turned off — from Android 8 the channel owns sound and heads-up, and
  // a per-notification flag is ignored.
  final ch = muted ? _msgMutedChannel : _msgChannel;
  // [NOTIF-ACTIONS-1] Hydrated here, not just in _showStackedMessageNotif,
  // because the reply handler redraws through this function from a headless
  // isolate where nothing has loaded config — the getter would otherwise always
  // return its compile-time default on that path.
  try { await RemoteConfig.hydrateFromDisk(); } catch (_) {/* defaults apply */}
  final withActions = RemoteConfig.notifQuickActions;
  await _ensureLocalInit(); // bg isolate: plugin isn't init'd here otherwise → crash
  await _local.show(
    _msgNotifId(conv), // per-CONVERSATION, not the old shared 8000
    isGroup && groupName.isNotEmpty ? groupName : fallbackTitle,
    (msgs.last['text'] ?? '').toString(),
    NotificationDetails(
      android: AndroidNotificationDetails(
        ch.id, ch.name,
        channelDescription: ch.description,
        icon: _kNotifIcon, // [NOTIF-ICON-1]
        importance: muted ? Importance.low : Importance.high,
        priority: muted ? Priority.low : Priority.high,
        number: count, // launchers read this for the icon badge count
        ticker: ticker,
        category: AndroidNotificationCategory.message,
        groupKey: _kMsgGroupKey, // ← the bundle
        styleInformation: style,
        actions: withActions ? _msgActions() : null,
      ),
    ),
    // Carries the conv so the tap opens THIS thread. The old payload was the
    // bare string 'chat', which is why every tap landed on the app home.
    payload: 'chat:$conv',
  );
  return true;
}

/// [NOTIF-ACTIONS-1] Reply / Mark as read / Mute.
List<AndroidNotificationAction> _msgActions() => <AndroidNotificationAction>[
      AndroidNotificationAction(
        _kActReply, 'Reply',
        // WITHOUT THIS THE SUGGESTION PILLS NEVER APPEAR. The "Okay / Thanks"
        // chips the owner asked for are Android's on-device Smart Reply, and
        // flutter_local_notifications defaults allowGeneratedReplies to FALSE
        // (verified in the constructor signature) — the opposite of
        // NotificationCompat's own default. Smart Reply also requires the
        // notification to be MessagingStyle and to carry a RemoteInput, both of
        // which are true here.
        allowGeneratedReplies: true,
        // The reply is posted straight from the background isolate; bringing the
        // app to the foreground would defeat the point of an inline reply.
        showsUserInterface: false,
        // Keep the card up while the send is in flight; the handler redraws it
        // with the sent message appended, or restores it on failure.
        cancelNotification: false,
        inputs: const <AndroidNotificationActionInput>[
          AndroidNotificationActionInput(
            label: 'Reply',
            // Our OWN chips, in addition to Smart Reply. Smart Reply is
            // Android-version and OEM dependent — it is absent on plenty of the
            // handsets AvaTOK's testers actually use — so these guarantee the
            // one-tap replies exist everywhere rather than only on a Pixel.
            choices: <String>['Okay', 'Thanks', '👍'],
            allowFreeFormInput: true,
          ),
        ],
      ),
      const AndroidNotificationAction(
        _kActRead, 'Mark as read',
        showsUserInterface: false,
      ),
      const AndroidNotificationAction(
        _kActMute, 'Mute',
        showsUserInterface: false,
      ),
    ];

/// [NOTIF-ACTIONS-1 2026-08-17] Entry point for Reply / Mark as read / Mute
/// tapped while the app is BACKGROUNDED OR DEAD.
///
/// Must be a top-level function with `@pragma('vm:entry-point')` — Android spawns
/// a fresh headless Dart isolate to run it, and without the pragma AOT
/// tree-shaking removes it, so the action silently does nothing in release and
/// works fine in debug. The only other entry points in this app are
/// `firebaseBackgroundHandler` (below) and `avatokBackgroundDispatcher`
/// (core/background_tasks.dart).
@pragma('vm:entry-point')
void notificationActionBackground(NotificationResponse resp) {
  // runInBackgroundIsolate sets the flag the rest of the codebase checks —
  // notably BadgeService.recompute, which must not try to open the drift DB
  // here because it does not exist in this isolate.
  unawaited(BadgeService.runInBackgroundIsolate(() => _runNotifAction(resp)));
}

/// Mark a conversation read on the server AND in local read state.
///
/// Both halves matter: the POST is what stops a fresh login or a second device
/// recounting these as unread, and ReadStateStore is what this device's own
/// unread badge is computed from.
///
/// The badge itself is deliberately NOT corrected here. `BadgeService.recompute`
/// returns early in a background isolate (badge_service.dart) because it needs
/// the drift DB, and there is no decrement primitive — only bump/clear/peek.
/// Guessing a number would be worse than being briefly stale, so the honest
/// count is left to the next foreground recompute.
Future<void> _markConvRead(String conv, String convKey) async {
  final sec = DateTime.now().millisecondsSinceEpoch ~/ 1000; // server wants SECONDS
  try {
    await ApiAuth.postJson(kMsgReadUrl, {'conv': conv, 'read_ts': sec});
  } catch (_) {/* best-effort; local state below still moves */}
  if (convKey.isNotEmpty) {
    try {
      await ReadStateStore().setRead(convKey, sec);
    } catch (_) {/* best-effort */}
  }
}

/// [NOTIF-ACTIONS-1] The actual work behind a notification action, in whichever
/// isolate it was invoked from.
Future<void> _runNotifAction(NotificationResponse resp) async {
  final action = resp.actionId ?? '';
  if (action != _kActReply && action != _kActRead && action != _kActMute) return;
  final payload = resp.payload ?? '';
  if (!payload.startsWith('chat:')) return;
  final conv = payload.substring('chat:'.length);
  if (conv.isEmpty) return;
  final input = (resp.input ?? '').trim();
  try {
    // A headless isolate has no plugin registrant, no AccountScope and — the one
    // that actually bites — no `ApiAuth.clerkBearer`. Without it every request
    // goes out UNAUTHENTICATED and 401s, which would look exactly like "reply is
    // broken". bootstrapBackgroundIsolate rebuilds precisely that slice and is
    // already the proven path for the WorkManager jobs. Skipped when we are on
    // the main isolate and it is all set up already.
    if ((AccountScope.id ?? '').isEmpty || ApiAuth.clerkBearer == null) {
      if (!await bootstrapBackgroundIsolate(tag: 'notifaction')) {
        await _track('notif_action', {'action': action, 'ok': false, 'reason': 'no_account'});
        return;
      }
    }
    final acct = await _shadeAccountId();
    if (acct.isEmpty) return;
    final all = await _readShadeBlob();
    final byConv = Map<String, dynamic>.from((all[acct] as Map?) ?? const <String, dynamic>{});
    final t = Map<String, dynamic>.from((byConv[conv] as Map?) ?? const <String, dynamic>{});
    // Stored when the notification was drawn — the bg isolate cannot re-derive
    // either of these from the conv id alone.
    final convKey = (t['k'] ?? '').toString();
    final peerUid = (t['to'] ?? '').toString();
    final isGroup = t['g'] == true;
    await _ensureLocalInit();

    if (action == _kActRead) {
      await _markConvRead(conv, convKey);
      await _clearShadeThread(conv);
      await _track('notif_action', {'action': 'read', 'ok': true, 'had_key': convKey.isNotEmpty});
      return;
    }

    if (action == _kActMute) {
      if (convKey.isEmpty) {
        await _track('notif_action', {'action': 'mute', 'ok': false, 'reason': 'no_key'});
        return;
      }
      // ChatFlagsStore only exposes a TOGGLE, and this button always says
      // "Mute" — so toggling blindly would UNMUTE an already-muted chat, which
      // is the opposite of what the user just pressed.
      final flags = await ChatFlagsStore().load();
      if (!(flags['muted'] ?? const <String>{}).contains(convKey)) {
        await ChatFlagsStore().toggle('muted', convKey);
      }
      await _clearShadeThread(conv);
      await _track('notif_action', {'action': 'mute', 'ok': true, 'muted': true});
      return;
    }

    // ── Reply ───────────────────────────────────────────────────────────────
    if (input.isEmpty) {
      await _track('notif_action', {'action': 'reply', 'ok': false, 'reason': 'empty'});
      return;
    }
    if (!isGroup && peerUid.isEmpty) {
      await _track('notif_action', {'action': 'reply', 'ok': false, 'reason': 'no_peer'});
      return;
    }
    // Deliberately a DIRECT post, NOT Outbox.enqueue. The outbox is a singleton
    // with per-isolate statics over an account-scoped file that the main isolate
    // holds a stale mirror of — enqueueing from here would risk the main isolate
    // overwriting the entry on its next persist, i.e. a reply that vanishes. The
    // in-repo precedent for a direct send is AvaDm.sendControl (sync/dm.dart).
    // The server is idempotent per client_id ([SRV-MSG-IDEMP-1]), so a retry
    // cannot double-send.
    //
    // The client_id is STAMPED INTO THE SHADE LOG BEFORE the post and reused if
    // this action runs again for the same text. A freshly-minted id per
    // invocation would defeat the server's own idempotency: some OEMs deliver a
    // notification action to the foreground callback as well as the background
    // isolate, and two different client_ids means the server sees two distinct
    // messages and the peer gets the reply twice. Keyed on the text too, so a
    // DIFFERENT reply after a failed one is not swallowed as a duplicate of it.
    final pendingId = (t['rid'] ?? '').toString();
    final pendingTxt = (t['rtxt'] ?? '').toString();
    final clientId = (pendingId.isNotEmpty && pendingTxt == input)
        ? pendingId
        : 'notif_${DateTime.now().microsecondsSinceEpoch}';
    if (clientId != pendingId) {
      t['rid'] = clientId;
      t['rtxt'] = input;
      byConv[conv] = t;
      all[acct] = byConv;
      await _persistShade(all);
    }
    final res = await ApiAuth.postJson(
      kMsgSendUrl,
      {
        if (isGroup) 'conv': conv else 'to': peerUid,
        'kind': 'text',
        // Same envelope the in-app composer builds (chat_thread/send.dart).
        'body': jsonEncode({'t': 'text', 'body': input}),
        'client_id': clientId,
      },
      timeout: const Duration(seconds: 20),
    );
    final ok = res.statusCode >= 200 && res.statusCode < 300;
    if (ok) {
      // Send committed — drop the retry stamp so the NEXT reply mints a new id.
      t.remove('rid');
      t.remove('rtxt');
      // Show the sent reply on the card, as WhatsApp does. It cannot come from
      // the local database — drift is not open in this isolate — so it is
      // appended to the shade log directly and the card redrawn. `self:true`
      // makes MessagingStyle attribute it to the user rather than the sender.
      final msgs = ((t['m'] as List?) ?? const <dynamic>[])
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
      msgs.add({
        'id': clientId, 'who': 'You', 'text': input,
        'ts': DateTime.now().millisecondsSinceEpoch, 'ava': '', 'self': true,
      });
      if (msgs.length > _kMaxShadeMsgs) {
        msgs.removeRange(0, msgs.length - _kMaxShadeMsgs);
      }
      t['m'] = msgs;
      byConv[conv] = t;
      all[acct] = byConv;
      await _persistShade(all);
      await _renderConvNotification(
        conv: conv, byConv: byConv,
        fallbackTitle: (t['who'] ?? 'AvaTOK').toString(),
        count: 0, ticker: 'Reply sent',
      );
      // Answering a message is reading it — WhatsApp clears the unread state on
      // an inline reply too.
      await _markConvRead(conv, convKey);
    } else {
      // THE CARD MUST BE REDRAWN EVEN ON FAILURE. `cancelNotification: false`
      // keeps the notification up while the send is in flight, and Android shows
      // an indefinite "sending" spinner on the reply field until the
      // notification is re-posted. Without this the spinner never stops — and
      // the most likely failure here is precisely a 401 from a headless isolate
      // that could not mint a bearer, i.e. the case the user most needs to see.
      // Redrawing from the unchanged log restores the card with the reply
      // un-sent, and the retry stamp above means pressing Reply again reuses the
      // same client_id rather than risking a double-send.
      await _renderConvNotification(
        conv: conv, byConv: byConv,
        fallbackTitle: (t['who'] ?? 'AvaTOK').toString(),
        count: 0, ticker: 'Reply not sent',
      );
    }
    await _track('notif_action', {
      'action': 'reply',
      // `sent` is the ship-gate success value. The action FIRING proves only
      // that a button was pressed; a 401 from a missing bearer in a headless
      // isolate is the most likely failure and would still emit the event.
      'sent': ok,
      'ok': ok,
      'status': res.statusCode,
      'group': isGroup,
      'chars': input.length,
    });
  } catch (e, st) {
    try {
      await _track('notif_action_failed', {
        'action': action,
        'error': e.toString(),
        'stack': st.toString().split('\n').take(4).join(' | '),
      });
    } catch (_) {/* telemetry must never break an action */}
  }
}

/// [NOTIF-STYLE-1] Draw (or update) ONE conversation's notification as an
/// Android MessagingStyle card, bundled with every other AvaTOK chat under a
/// shared group, and refresh the "N messages from M chats" summary above them.
///
/// Returns true when the shade was updated or the push was a duplicate that
/// deliberately changed nothing; false when it failed and the caller should fall
/// back to the legacy single banner.
Future<bool> _showStackedMessageNotif(
  Map<String, dynamic> d, {
  required String conv,
  required String who,
  required String preview,
  required int count,
}) async {
  try {
    final acct = await _shadeAccountId();
    // No resolvable account = no safe place to file this. The shared-phone rule
    // in the rulebook is not negotiable: an unscoped write here would leak one
    // family member's message previews into another's shade.
    if (acct.isEmpty) return false;
    // [NOTIF-ACTIONS-1] The background FCM isolate never sets AccountScope, but
    // ChatFlagsStore/ReadStateStore are account-SCOPED (cache/<id>/...). Without
    // this they would silently read the 'guest' scope — which on a shared phone
    // is both a wrong answer and a cross-account leak. Statics are per-isolate,
    // so assigning here cannot disturb the main isolate.
    if ((AccountScope.id ?? '').isEmpty) AccountScope.id = acct;

    final mid = (d['mid'] ?? '').toString();
    final isGroup = (d['isGroup'] ?? '').toString() == 'true';
    final groupName = (d['groupName'] ?? '').toString();
    // Server `ts` is milliseconds as a STRING (FCM data values are always
    // strings). Absent on a pre-[NOTIF-PAYLOAD-1] server → now, which keeps the
    // ordering sane rather than pinning every message to the epoch.
    final ts = int.tryParse((d['ts'] ?? '').toString()) ??
        DateTime.now().millisecondsSinceEpoch;
    final avatarPath = await _shadeAvatarPath(
      (d['senderAvatarUrl'] ?? '').toString(),
      (d['senderAvatarVersion'] ?? '').toString(),
    );

    await _ensureLocalInit(); // needed by _pruneDismissed as well as the show below
    final upd = await _buildShadeUpdate(
      acct: acct, conv: conv, mid: mid, who: who,
      text: preview.isEmpty ? 'New message' : preview,
      ts: ts, isGroup: isGroup, groupName: groupName, avatarPath: avatarPath,
      // [NOTIF-ACTIONS-1] A group's server conv id IS its gid (see
      // worker/src/routes/messaging.ts, where a group job uses conv: gid), so the
      // local key is 'g:<conv>'. A DM's local key is keyed on the PEER, which is
      // the sender of this push.
      peerUid: (d['fromUid'] ?? '').toString(),
      convKey: isGroup
          ? 'g:$conv'
          : ((d['fromUid'] ?? '').toString().isEmpty
              ? ''
              : '1:${(d['fromUid'] ?? '').toString()}'),
    );
    // Duplicate delivery — the shade is already correct. Returning true stops the
    // caller re-drawing anything.
    if (upd == null) {
      await _track('push_shown_duplicate', {'type': 'message', 'had_mid': mid.isNotEmpty});
      return true;
    }
    final byConv = upd.byConv;

    // Rendering lives in _renderConvNotification so the reply action can redraw
    // the SAME card with the sent message appended, instead of a second copy of
    // this logic drifting away from it.
    final drawn = await _renderConvNotification(
      conv: conv, byConv: byConv, fallbackTitle: who, count: count, ticker: 'Message from $who',
    );
    if (!drawn) return false;
    // Persist ONLY now that the render has actually succeeded — see
    // _buildShadeUpdate's contract. A throw above leaves the log untouched, so
    // the legacy fallback banner is the only thing on screen and the message is
    // not silently recorded as already shown.
    await _persistShade(upd.all);
    // A conversation pushed out by the cap still has a live notification. Left
    // alone it sits in the bundle as a child the summary no longer counts and
    // nothing will ever update again.
    for (final k in upd.evicted) {
      await _local.cancel(_msgNotifId(k));
    }
    await _renderShadeSummary(byConv);
    await _track('push_shown', {
      'channel': 'messages',
      'type': 'message',
      'path': BadgeService.inBackgroundIsolate ? 'background' : 'foreground',
      'has_preview': preview.isNotEmpty,
      'icon': _kNotifIcon, // [NOTIF-ICON-1]
      // [NOTIF-STYLE-1] The success values. `style` distinguishes the new
      // MessagingStyle render from the legacy BigText one, and `grouped` proves
      // the notification actually carried a groupKey — the two things that make
      // the bundle in the owner's screenshot possible. Reading these on a real
      // build is the ship-gate assertion, not the mere arrival of push_shown.
      'style': 'messaging',
      'grouped': true,
      'is_group': isGroup,
      'thread_msgs': (((byConv[conv] as Map?) ?? const <String, dynamic>{})['m'] as List?)?.length ?? 0,
      'has_avatar': avatarPath.isNotEmpty,
    });
    return true;
  } catch (e, st) {
    // NOT Analytics.captureException: this runs in the background isolate too,
    // where PostHog does not exist and the call itself can throw — turning a
    // recoverable render failure into an unhandled one, on the exact path whose
    // job is to be recoverable. `_track` routes per-isolate to the durable
    // queue the main isolate ships on next foreground.
    try {
      await _track('push_stacked_failed', {
        'error': e.toString(),
        'stack': st.toString().split('\n').take(4).join(' | '),
      });
    } catch (_) {/* telemetry must never be the thing that breaks a notification */}
    return false; // caller redraws the legacy banner — never leave the user silent
  }
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

  // ── [NOTIF-STYLE-1] Stacked, per-conversation, MessagingStyle path ─────────
  //
  // Preferred whenever the push carries a conversation id. Falls through to the
  // legacy single-banner code below when it does not — which is exactly the case
  // for a push minted by a server version older than [NOTIF-PAYLOAD-1], and for
  // the internal DO producers (voicemail transcripts, auto-replies) that call
  // the notify lane without a conv. Those must keep working unchanged rather
  // than silently losing their banner.
  final conv = (d['conv'] ?? '').toString();
  if (conv.isNotEmpty) {
    // RemoteConfig's in-memory map is EMPTY in the background isolate — nothing
    // hydrates it there — so without this the kill switch would read its
    // compile-time default on precisely the code path that matters most (a push
    // arriving while the app is asleep). Cheap, idempotent, and memoised behind
    // `_hydrated`.
    try { await RemoteConfig.hydrateFromDisk(); } catch (_) {/* defaults apply */}
    if (RemoteConfig.notifMessagingStyle) {
      // true  → drawn, or deliberately skipped as a duplicate. Done.
      // false → the stacked render FAILED. Fall through to the legacy banner
      //         below, so a bug in the new code degrades to the old behaviour
      //         instead of to silence. A missed message notification is a much
      //         worse outcome than an unstyled one.
      final handled = await _showStackedMessageNotif(
        d, conv: conv, who: who, preview: preview, count: count,
      );
      if (handled) return;
    }
  }
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
        icon: _kNotifIcon, // [NOTIF-ICON-1]
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
    // [NOTIF-ICON-1] Which status-bar glyph this banner was drawn with. The
    // pre-fix value was the launcher mipmap, which Android silhouettes into a
    // white blob; `icon:'ic_notification'` on a build is the proof the
    // monochrome asset actually resolved and shipped. This is a literal echo of
    // what was passed to AndroidNotificationDetails, NOT a hardcoded 'true' —
    // if the constant is ever reverted, this property reverts with it.
    'icon': _kNotifIcon,
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
    // [RECEPT-CALLER-IDENTITY-1] The third input. tier=='unknown' with all three
    // false is the "Missed call from Unknown caller" fingerprint — alert on it.
    'had_caller_name': rawCallerName.isNotEmpty,
    'call_id': (d['callId'] ?? d['call_id'] ?? '').toString(),
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
    icon: _kNotifIcon, // [NOTIF-ICON-1]
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
    icon: _kNotifIcon, // [NOTIF-ICON-1]
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

/// Cancel any branded incoming-call FSI notification left by an older build
/// answered / declined / caller cancelled), so it can't linger over the lock
/// screen. Best-effort and safe to call more than once.
Future<void> _dismissBrandedFsi() async {
  try { await _local.cancel(_kBrandedIncomingNotifId); } catch (_) {}
}

/// [AVACALL-INUI-2] If [payload] is a branded-incoming full-screen-intent JSON
/// payload, dismiss the FSI notification and route to IncomingBusinessCallScreen.
/// Returns true if it handled the payload (so the caller skips the plain
/// inbox-tap routing). Main isolate only — it drives the navigator.
bool _maybeRouteBrandedIncoming(String? payload) {
  if (payload == null || !payload.startsWith('{')) return false;
  try {
    final m = jsonDecode(payload);
    if (m is Map && m['k'] == _kBrandedIncomingPayloadKind) {
      unawaited(_dismissBrandedFsi());
      unawaited(_routeToBrandedIncoming(Map<String, dynamic>.from(m)));
      return true;
    }
  } catch (_) {/* not our payload — fall through */}
  return false;
}

/// [CALL-IDENTITY-SNAPSHOT-1 2026-08-01] The ONE place that reads the caller's
/// avatar out of a ring payload.
///
/// `callerAvatarUrl` is what the server now stamps from the caller's public
/// AvaTOK profile (worker routes/api.ts → consumers fcm.ts). The legacy
/// `avatarUrl` / `fromAvatar` keys are kept purely as fallbacks — and note that
/// NO producer has ever emitted either of them, which is precisely why the
/// incoming-call screen has only ever shown a letter tile. Both the FCM ring
/// and the faster InboxDO WS ring carry the same key, so the fast path and the
/// slow path paint the same thing and there is no flicker.
String callerAvatarFromPayload(Map<String, dynamic> d) =>
    (d['callerAvatarUrl'] ?? d['avatarUrl'] ?? d['fromAvatar'] ?? '').toString().trim();

/// [AVACALL-INUI-2] Push the branded IncomingBusinessCallScreen from a decoded
/// FSI payload. Retries briefly: on a COLD start (the FSI just launched us over
/// the lock screen) the root navigator may not be mounted the instant the
/// payload is delivered. Bounded so it never spins forever.
final CallTtlGate _brandedRouteGate =
    CallTtlGate(ttlMs: _kTerminalCallTtlMs);

Future<void> _routeToBrandedIncoming(Map<String, dynamic> d) async {
  final callId = (d['callId'] ?? '').toString();
  if (callId.isEmpty) return;
  // Don't surface a screen for a call the caller already cancelled (WS5 guard).
  if (PushService.wasCallTerminated(callId)) return;
  // [CALL-PREWARM-2 2026-08-17] The SECOND (and, in production, the DOMINANT)
  // ring lane. `_showIncoming` carries the original [CALL-PREWARM-1] hook, but
  // it is only one of the ways a ring reaches a screen: the branded incoming
  // screen is also entered directly from the native tap channel
  // (`avatok/incoming_call_tap` → MainActivity, warm AND cold-start pending)
  // without `_showIncoming` running at all. The 2026-08-17 08:25 prod call
  // proved it — `call_branded_fsi_routed` with NO `call_incoming_received`,
  // NO `call_incoming_shown`, and therefore not one `call_prewarm_started` in
  // the entire project history: P1 never executed on a real call.
  //
  // Placed BEFORE the duplicate-route gate on purpose. Two lanes converging is
  // exactly the case where one of them gets suppressed, and the prewarm must
  // still run; `CallPrewarm.start` is idempotent per callId, so the loser of
  // the gate race costs nothing.
  try {
    CallPrewarm.instance.start(callId);
  } catch (_) {/* prewarm must never affect the ring path */}
  // Warm/cold native taps plus FCM/WS delivery can converge while the navigator
  // is mounting. Reserve before awaiting so one callId opens exactly one route.
  if (!_brandedRouteGate.tryReserve(callId)) {
    Analytics.capture('call_branded_fsi_duplicate_suppressed', {
      'call_id': callId,
    });
    return;
  }
  for (var i = 0; i < 40; i++) { // ~10s max (40 × 250ms)
    final nav = navigatorKey.currentState;
    if (nav != null) {
      if (PushService.wasCallTerminated(callId)) return; // re-check after the wait
      nav.push(MaterialPageRoute(
        builder: (_) => IncomingBusinessCallScreen(
          callId: callId,
          fromUid: (d['from'] ?? d['fromPub'] ?? '').toString(),
          fromName: (d['fromName'] ?? 'AvaTOK').toString(),
          avatarUrl: callerAvatarFromPayload(d),
          avatarVersion: (d['callerAvatarVersion'] ?? '').toString(),
          video: (d['kind'] ?? '') == 'video',
        ),
      ));
      Analytics.capture('call_branded_fsi_routed', {
        'call_id': callId,
        // [CALL-IDENTITY-SNAPSHOT-1] has_avatar=false in prod means the ring
        // screen is painting a letter tile instead of the caller's photo.
        'has_avatar': callerAvatarFromPayload(d).isNotEmpty,
      });
      return;
    }
    await Future<void>.delayed(const Duration(milliseconds: 250));
  }
  _brandedRouteGate.release(callId);
  Analytics.capture('call_branded_fsi_route_timeout', {'call_id': callId});
}

// ── [CALL-REL-9] REL-10: callee ring audibility ─────────────────────────────
// `call_incoming_shown` only proves the incoming-call UI was SHOWN — never
// that a ring was AUDIBLE. CallKit owns the ringtone; silent/vibrate mode, an
// active DND filter, ring volume 0, or OEM heads-up-only behavior while the
// phone is in active use all produce a completely silent "ring" that looks
// identical in that event (2026-07-23 incident: Tiger heard nothing with the
// phone in his hand). See Specs/FINAL-CALL-RELIABILITY-PLAN-2026-07-24.md §2
// item 10 / Specs/AVATOK-CALL-SYSTEM-BIBLE-2026-07-24.md Part 3 + Part 9.
//
// Reuses the ALREADY-REGISTERED `avatok/voice_audio` platform channel (see
// [NativeVoiceAudio] / AvaVoiceAudioPlugin.kt's `canUseFullScreenIntent`)
// rather than adding a new plugin — this file only needs one extra method on
// an existing, already-attached channel, not a new MainActivity registration.
const MethodChannel _ringAudibilityChannel = MethodChannel('avatok/voice_audio');

/// Native probe: ringer mode, DND/interruption-filter state, ring-stream
/// volume + max, and the incoming-call channel's importance — AT RING TIME
/// (not cached; see the Kotlin doc comment on `getRingAudibilityInfo`).
/// Android-only in this pass; iOS/desktop return `ok:false` so callers treat
/// the result as 'unknown' rather than silently guessing.
Future<Map<String, dynamic>> _probeRingAudibility() async {
  if (!Platform.isAndroid) {
    return {'ok': false, 'reason': 'unsupported_platform'};
  }
  try {
    final r = await _ringAudibilityChannel
        .invokeMapMethod<String, dynamic>('getRingAudibilityInfo');
    return r ?? {'ok': false, 'reason': 'null_result'};
  } catch (e) {
    return {'ok': false, 'reason': e.toString()};
  }
}

// The current in-app ringtone-fallback player (at most one at a time — only
// one call can be ringing on this device). Tracked with the callId it's
// serving so a fast glare sequence (call A's teardown racing call B's ring)
// can't cross-silence the wrong call.
ap.AudioPlayer? _fallbackRingtonePlayer;
String? _fallbackRingtoneCallId;

/// [CALL-REL-9] Play a bundled ringtone through the app's OWN audio path as a
/// backup, looping until [_stopRingtoneFallback] is called. Gated by the
/// caller to ONLY the case where the phone is foreground/unlocked, the user's
/// OWN ringer setting is NORMAL (never overrides silent/vibrate/DND), and
/// nothing confirms CallKit's native ring is actually making sound — the
/// in-hand/OEM heads-up-only failure mode REL-10 targets. Reuses the bundled
/// ringtone catalog asset (assets/audio/catalog/) already shipped for the
/// ringback picker — no new asset, no new audio plugin.
/// ⚠️ [CALL-RING-OWNER-1 2026-08-05] READ BEFORE "FIXING" THIS.
///
/// The name "fallback" and the reason string below both describe a design that
/// is NOT what this is. There is no audibility check gating it: the only caller
/// starts it unconditionally the moment the OS ring is suppressed, one line
/// before capturing `call_os_ring_suppressed`. Nothing anywhere sets, clears or
/// waits on a "confirmed sound" signal — grep the repo, the symbol does not
/// exist — and `IncomingBusinessCallScreen` contains no audio code at all, so
/// the branded surface is structurally incapable of confirming anything.
///
/// Which means: WHEN THE APP IS FOREGROUND, THIS IS THE ONLY THING THAT MAKES A
/// RINGING SOUND. `suppressOsRingInForeground` is true in production, so the OS
/// ring is off; delete or gate this and foreground calls arrive in silence.
/// A 2026-08-05 investigation into a "double ring" report nearly did exactly
/// that. The second ring was not this — it was a GHOST full-screen surface
/// re-raised 34s after hang-up for an already-ended call (see
/// [CALL-GHOST-RING-1] in call_session.dart), which brought CallKit's own ring
/// back with it.
///
/// So the reason string is now honest about what actually triggered it, and the
/// audibility-conditional behaviour the old string implied remains UNBUILT.
/// If it is ever built, `callRingAudibilityV1` is the flag to gate it behind.
Future<void> _startRingtoneFallback(String callId) async {
  if (_fallbackRingtonePlayer != null) return; // already running for this or another call
  // [CALL-GHOST-RING-1] Never ring for a call that has already ended. Cheap, and
  // the terminal marker is now actually set on local hang-up, so unlike before
  // this guard can really fire.
  if (PushService.wasCallTerminated(callId)) {
    await _track('call_ring_fallback_suppressed', {
      'call_id': callId,
      'reason': 'call_already_terminated',
    });
    return;
  }
  try {
    final player = ap.AudioPlayer();
    _fallbackRingtonePlayer = player;
    _fallbackRingtoneCallId = callId;
    await player.setReleaseMode(ap.ReleaseMode.loop);
    await player.play(ap.AssetSource('audio/catalog/classic.mp3'));
    await _track('call_ring_fallback_played', {
      'call_id': callId,
      // Was 'foreground_normal_ringer_no_confirmed_sound', which named a check
      // that has never existed. This is the real trigger.
      'reason': 'os_ring_suppressed_app_owns_ring',
    });
  } catch (e) {
    _fallbackRingtonePlayer = null;
    _fallbackRingtoneCallId = null;
  }
}

/// Stop the fallback ringtone (best-effort, idempotent). When [callId] is
/// given it only stops if it matches the call the fallback is currently
/// serving — see the glare note above.
Future<void> _stopRingtoneFallback([String? callId]) async {
  // [CALL-4RINGS-1 2026-08-08] STOP COUNTING RINGS HERE, and deliberately at the
  // TOP — before the `player == null` early return below.
  //
  // This function is already the universal ring-teardown hook: every terminal
  // path calls it (accept, decline, native timeout, call-ended, glare cleanup,
  // programmatic end, local hang-up — sixteen sites). Hooking the reporter here
  // rather than at each of those sites is what guarantees "stop immediately on
  // answer/decline/cancel/timeout" cannot be missed by a path someone adds
  // later. It must run even when no fallback tone was playing, which is the
  // common case: the fallback only runs when the app owns the ring in the
  // foreground, while the reporter runs for EVERY ring.
  _RingCycleReporter.I.stop(callId);
  final player = _fallbackRingtonePlayer;
  if (player == null) return;
  if (callId != null && _fallbackRingtoneCallId != null && callId != _fallbackRingtoneCallId) {
    return;
  }
  _fallbackRingtonePlayer = null;
  _fallbackRingtoneCallId = null;
  try {
    await player.stop();
    await player.dispose();
  } catch (_) {/* best-effort */}
}

// ── [CALL-4RINGS-1 2026-08-08] PER-CYCLE RING RECEIPTS ──────────────────────
//
// THE RULE (owner): Ava takes over after FOUR REAL RINGS — four times the
// callee's device genuinely produced a ring cycle. Not after twenty seconds.
//
// Until now `reportRinging` was a ONE-SHOT: the callee reported the first ring
// and never spoke again, so the server could not tell "rang four times, nobody
// picked up" from "never rang at all" and had nothing to count. This reporter is
// the missing half — it keeps saying "still ringing, cycle N" for as long as the
// incoming-call UI is genuinely up, and shuts up the instant the ring ends.
//
// MEASURED vs DERIVED — read this before "improving" it.
// Android exposes NO per-ring-cycle callback. Neither ConnectionService/CallKit
// nor `Ringtone`/`RingtoneManager` will tell you a cycle boundary, and
// `flutter_callkit_incoming` surfaces nothing of the sort; the OS ringtone is
// played by the system in another process. So when the OS owns the ring the
// cycle is DERIVED from a timer seeded at `ringCycleMs` and every receipt is
// stamped `derived:true`. When the APP owns the ring — foreground, OS ring
// suppressed, `_startRingtoneFallback` looping our own bundled tone — we can ask
// that player for the tone's real duration, so those cycles are MEASURED and
// stamped `derived:false`. Keeping the two distinguishable on the wire is the
// whole point: a guess presented as a measurement is how "four rings" quietly
// becomes "twenty-four seconds" again.
//
// A receipt with `audible:'false'` or `dndBlocking:true` is still SENT (the
// caller's honest ring copy and the telemetry both want it) but the server does
// not count it — a silent phone in a pocket has not rung.
class _RingCycleReporter {
  _RingCycleReporter._();
  static final _RingCycleReporter I = _RingCycleReporter._();

  /// Hard bound on receipts per call. The SERVER decides when the ring is over;
  /// this only stops a wedged ring surface POSTing forever if every teardown
  /// path somehow failed to fire. Comfortably above any sane `receptionistRings`.
  static const int _maxCycles = 10;

  /// Hard bound on wall-clock reporting, independent of [_maxCycles], for the
  /// case where `ringCycleMs` has been flipped to something small.
  static const Duration _maxDuration = Duration(seconds: 90);

  Timer? _timer;
  String? _callId;
  String? _token;
  String _route = 'unknown';
  int _index = 0;
  int _startedAtMs = 0;
  bool _busy = false;

  /// Begin (or restart for a new call) per-cycle reporting.
  void start(String callId, String token, {required String route}) {
    if (!RemoteConfig.callRealRingCount) return;
    if (callId.isEmpty || token.isEmpty) return;
    if (_callId == callId && _timer != null) return; // already reporting this call
    stop(); // a new ring supersedes any previous one (glare)
    _callId = callId;
    _token = token;
    _route = route;
    _index = 0;
    _startedAtMs = DateTime.now().millisecondsSinceEpoch;
    // Cycle 1 is reported IMMEDIATELY, not one interval later: the OS ring is
    // already audible by the time we get here, so waiting `ringCycleMs` would
    // lose a real ring and push the handoff a full cycle late.
    // [_report] owns re-arming (it knows the MEASURED cycle length when the app
    // owns the tone). Arming here too would leave a stray timer behind whenever
    // the first report short-circuits.
    unawaited(_report());
  }

  /// Stop reporting. With [callId] it only stops if that is the call currently
  /// being reported — same glare rule as [_stopRingtoneFallback], so call A's
  /// teardown cannot silence call B's ring.
  void stop([String? callId]) {
    if (callId != null && _callId != null && callId != _callId) return;
    _timer?.cancel();
    _timer = null;
    _callId = null;
    _token = null;
    _index = 0;
  }

  void _arm(int ms) {
    _timer?.cancel();
    final interval = ms < 1000 ? 1000 : (ms > 20000 ? 20000 : ms);
    _timer = Timer(Duration(milliseconds: interval), () {
      unawaited(_report());
    });
  }

  Future<void> _report() async {
    final callId = _callId;
    final token = _token;
    if (callId == null || token == null) return;
    if (_busy) return; // a slow POST must not stack up behind the next tick
    // The ring is over the moment the call is terminal, even if a teardown path
    // has not reached [stop] yet.
    if (PushService.wasCallTerminated(callId)) {
      stop(callId);
      return;
    }
    if (_index >= _maxCycles ||
        DateTime.now().millisecondsSinceEpoch - _startedAtMs > _maxDuration.inMilliseconds) {
      stop(callId);
      return;
    }
    _busy = true;
    try {
      _index += 1;
      final cycle = _index;
      // Re-probed EVERY cycle, not cached from the first: the user can silence
      // the phone or flip DND mid-ring, and a cached "audible:true" would keep
      // counting rings that stopped making a sound.
      final info = await _probeRingAudibility();
      final ok = info['ok'] == true;
      final ringerMode = (info['ringer_mode'] ?? 'unknown').toString();
      final dndBlocking = info['dnd_blocking'] == true;
      final ringVolume = info['ring_volume'] is int ? info['ring_volume'] as int : -1;
      final ringVolumeMax =
          info['ring_volume_max'] is int ? info['ring_volume_max'] as int : -1;
      final silentOrVibrate = ringerMode == 'silent' || ringerMode == 'vibrate';
      // Is the APP the thing making the noise right now? When the OS ring is
      // suppressed in the foreground, `_startRingtoneFallback` is playing our own
      // bundled tone through our own player — we do not need to ask Android
      // whether a sound is happening, because we are the ones causing it. This
      // matters because `_probeRingAudibility` goes over the
      // `avatok/voice_audio` MethodChannel, which is registered by MainActivity
      // and is therefore NOT available in the FCM background isolate.
      final appOwnsTone =
          _fallbackRingtonePlayer != null && _fallbackRingtoneCallId == callId;
      final String audible;
      if (silentOrVibrate || dndBlocking || (ok && ringVolume == 0)) {
        // Positive evidence of silence always wins, including over appOwnsTone —
        // our player obeys the same ringer stream.
        audible = 'false';
      } else if (ok) {
        audible = 'true';
      } else if (appOwnsTone) {
        audible = 'true';
      } else {
        // No probe and no app-owned tone: we genuinely do not know, and the
        // server must NOT count this as a ring. The wall-clock backstop is what
        // covers this population — that is precisely its job.
        audible = 'unknown';
      }

      // MEASURED where we can be: when the app owns the ring, the looping
      // bundled tone's real duration IS the cycle length.
      var derived = true;
      var nextIntervalMs = RemoteConfig.ringCycleMs;
      final owned = _fallbackRingtonePlayer;
      if (owned != null && _fallbackRingtoneCallId == callId) {
        try {
          final d = await owned.getDuration();
          final ms = d?.inMilliseconds ?? 0;
          if (ms >= 1000 && ms <= 20000) {
            derived = false;
            nextIntervalMs = ms;
          }
        } catch (_) {/* fall back to the assumed cycle */}
      }

      if (_callId != callId) return; // superseded while we were probing
      await PushService.reportRinging(
        callId,
        token,
        route: _route,
        ringIndex: cycle,
        derived: derived,
        audible: audible,
        ringerMode: ok ? ringerMode : null,
        dndBlocking: ok ? dndBlocking : null,
        ringVolume: ok && ringVolume >= 0 ? ringVolume : null,
        ringVolumeMax: ok && ringVolumeMax >= 0 ? ringVolumeMax : null,
      );
      await _track('call_ring_cycle_reported', {
        'call_id': callId,
        'ring_index': cycle,
        'audible': audible,
        'derived': derived,
        'ringer_mode': ringerMode,
        'dnd_blocking': dndBlocking,
        'route': _route,
        'ms_since_first_ring': DateTime.now().millisecondsSinceEpoch - _startedAtMs,
        'cycle_ms': nextIntervalMs,
      });
      if (_callId == callId) _arm(nextIntervalMs);
    } catch (e) {
      // A failed receipt must not stop the ring or the reporter — the server's
      // wall-clock backstop is exactly what covers a device that goes quiet.
      unawaited(Analytics.captureException(e, StackTrace.current,
          handled: true,
          extra: {'where': 'ring_cycle_report', 'call_id': callId}));
      if (_callId == callId) _arm(RemoteConfig.ringCycleMs);
    } finally {
      _busy = false;
    }
  }
}

/// Emit `call_ring_audibility` and its optional receipt echo. Fired unawaited
/// from [_showIncoming] so telemetry never delays or blocks the ring itself.
///
/// `audible`:
///  · `'false'`   — ringer mode silent/vibrate, DND is blocking, OR the ring
///                  stream volume is 0. The device CANNOT have rung audibly.
///  · `'true'`    — ringer mode normal, DND not blocking, ring volume > 0, AND
///                  `showCallkitIncoming` returned without error. Still a
///                  proxy (actual speaker output isn't observable) — not a
///                  hard guarantee the human heard it.
///  · `'unknown'` — the native probe failed (iOS/desktop, plugin error) or
///                  CallKit never even reported showing.
Future<void> _emitRingAudibilityAndMaybeFallback(
  Map<String, dynamic> d, {
  required bool callkitShown,
  required String route,
  required String lifecycle,
  required bool fsiGranted,
}) async {
  final callId = (d['callId'] ?? '').toString();
  if (callId.isEmpty) return;
  final info = await _probeRingAudibility();
  final ok = info['ok'] == true;
  final ringerMode = (info['ringer_mode'] ?? 'unknown').toString();
  final interruptionFilter = (info['interruption_filter'] ?? 'unknown').toString();
  final dndBlocking = info['dnd_blocking'] == true;
  final ringVolume = info['ring_volume'] is int ? info['ring_volume'] as int : -1;
  final ringVolumeMax = info['ring_volume_max'] is int ? info['ring_volume_max'] as int : -1;
  final channelImportance = (info['channel_importance'] ?? 'unknown').toString();
  // What Android actually granted at ring time — the same signal the branded
  // FSI decision in [_showIncoming] uses (`lifecycle == 'resumed'` → a live
  // navigator in-app; else FSI vs the plain native CallKit fallback screen).
  final presentation = lifecycle == 'resumed'
      ? 'in_app_foreground'
      : (fsiGranted ? 'full_screen_intent' : 'heads_up_or_none');
  final silentOrVibrate = ringerMode == 'silent' || ringerMode == 'vibrate';
  final volumeZero = ringVolume == 0;
  final String audible;
  if (!ok || !callkitShown) {
    audible = 'unknown';
  } else if (silentOrVibrate || dndBlocking || volumeZero) {
    audible = 'false';
  } else {
    audible = 'true';
  }
  await _track('call_ring_audibility', {
    'call_id': callId,
    'trace_id': (d['trace_id'] ?? '').toString(),
    'route': route,
    'ringer_mode': ringerMode,
    'interruption_filter': interruptionFilter,
    'dnd_blocking': dndBlocking,
    'ring_volume': ringVolume,
    'ring_volume_max': ringVolumeMax,
    'channel_importance': channelImportance,
    'callkit_shown': callkitShown,
    'presentation': presentation,
    'probe_ok': ok,
    if (!ok) 'probe_error': (info['reason'] ?? '').toString(),
    'audible': audible,
  });
  // [CALL-REL-9] Attach a compact echo of this to whatever ring receipt the
  // callee already sends the server (PushService.reportRinging /
  // /api/call/ringing → CallRoom DO device-ringing). Fired as a SECOND,
  // best-effort call with the SAME token — the initial (audibility-free) call
  // already fired immediately at ring time for caller-ringback latency and is
  // UNCHANGED; the token is re-validated but not consumed server-side, so a
  // repeat POST is safe. Data-plumbing only in this pass: the CallRoom DO does
  // not yet branch on these fields (follow-up), and caller-side "phone is on
  // silent" UI honesty is explicitly NOT built here — see the report.
  // [CALL-REL-9] Gated behind `callRingAudibilityV1`: with the flag off this
  // second POST must not fire at all, so the network path is byte-equivalent
  // to before this feature existed. `call_ring_audibility` above is emitted
  // either way — only this audibility-echo POST is gated.
  final ringToken = (d['ringReceiptToken'] ?? '').toString();
  // [CALL-4RINGS-1 2026-08-08] Start per-cycle reporting. Gated on
  // `callRealRingCount` ONLY — deliberately not on `callRingAudibilityV1`, which
  // ships dark (false in DEFAULTS): chaining the two would leave the four-ring
  // rule inert behind an unrelated flag while the server waited for receipts
  // that were never going to be sent.
  //
  // This runs even when [callkitShown] is false. A suppressed OS ring is still a
  // ring — the app is playing the tone itself in that case — and the AUDIBILITY
  // probe, not the CallKit return value, is what decides whether the server
  // counts it.
  if (ringToken.isNotEmpty && callId.isNotEmpty) {
    _RingCycleReporter.I.start(callId, ringToken, route: route);
  }
  if (RemoteConfig.callRingAudibilityV1 && ringToken.isNotEmpty) {
    unawaited(PushService.reportRinging(
      callId,
      ringToken,
      audible: audible,
      ringerMode: ok ? ringerMode : null,
      dndBlocking: ok ? dndBlocking : null,
      ringVolume: ok && ringVolume >= 0 ? ringVolume : null,
      ringVolumeMax: ok && ringVolumeMax >= 0 ? ringVolumeMax : null,
    ));
  }
  // [CALL-NOTIF-OWNER-1] Never start Dart audio while CallKit owns the native
  // notification. This old "fallback" ran whenever the native probe reported a
  // healthy audible ring — exactly when Android was already playing one — and
  // produced the Motorola + AvaTOK double ringtone. Foreground branded calls
  // that deliberately suppress CallKit start Dart audio in [_showIncoming]; all
  // other lifecycle states have one native owner and one bundled product tone.
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
  final ringCallId = (d['callId'] ?? '').toString();
  final ringCaller = (d['fromPub'] ?? d['from'] ?? '').toString();
  // All incoming transports converge here. A late FCM delivery from the
  // background isolate must not resurrect the ring after the user accepted
  // the same call on the foreground isolate.
  if (await _wasIncomingCallAcceptedDurably(ringCallId)) {
    Analytics.capture('call_ghost_ring_suppressed', {
      'call_id': ringCallId,
      'route': route,
      'reason': 'accepted_lease',
    });
    try { await FlutterCallkitIncoming.endCall(ringCallId); } catch (_) {}
    await _track(CallEvents.callIncomingShown, {
      'call_id': ringCallId,
      'route': route,
      'shown': false,
      'skip_reason': 'accepted_lease',
    });
    return;
  }
  // `_showIncoming` is a TOP-LEVEL function, not a member of PushService, so a
  // private static of that class has to be named through it — exactly as the
  // `PushService._signalStatus` call on the next line already does. Unqualified,
  // this is `Method not found: '_suppressSameCallerRetry'` and it broke the
  // compile gate on run 31062575013.
  if (route != 'ws' && route != 'fcm_fg' &&
      PushService._suppressSameCallerRetry(ringCallId, ringCaller)) {
    PushService._signalStatus(ringCallId, 'busy', ringCaller,
        busyReason: 'active_call', receptionistEnabled: true);
    try { await FlutterCallkitIncoming.endCall(ringCallId); } catch (_) {}
    return;
  }
  // [CALL-CALLEE-SEQ-1 2026-08-03] Seed the callee's ordering baseline from the
  // ring itself, on every ring route.
  //
  // The caller's transitions have always carried the CallRoom's monotonic
  // `transition_sequence` and this reducer correctly drops the stale ones (59
  // `stale_seq` drops in a fortnight). The CALLEE had no sequence to compare
  // against: the ring — the message that opens the interaction — carried none,
  // so local taps recorded a floor of 0 and any server transition, however old,
  // beat it. `-1` and `0` can never lose a comparison.
  //
  // The ring's sequence is the floor for everything that follows on this call:
  // a genuine later transition is strictly greater, and anything at or below it
  // is a replay from an at-least-once queue, a reconnect, or the other isolate.
  _noteRingSequence(ringCallId, int.tryParse((d['seq'] ?? '').toString()));
  // [CALL-WS-AUTH-1 2026-08-03] Deposit the CALLEE's CallRoom join credential
  // the moment the ring payload arrives, and BEFORE any of the freshness /
  // suppression / surface-raising work below.
  //
  // Placement matters: accepting a call goes straight from the ring surface to
  // the signalling WebSocket with no authenticated round-trip in between, so if
  // the token is not already deposited by the time the user taps Accept there is
  // nowhere left to fetch it from. This runs on every ring route (background
  // FCM, foreground FCM and the InboxDO WS ring), which is the whole reason it
  // lives in `_showIncoming` rather than in each caller.
  //
  // Absent on a push from a server that predates this change → nothing is
  // recorded and the join stays un-credentialed, which is admitted while
  // `callRoomAuthEnforced` is off.
  // [CALL-REL-R4-3 2026-08-03] AWAITED on purpose. This runs in the FCM
  // background isolate for a killed/backgrounded app, and that isolate can be
  // torn down as soon as its handler returns — an unawaited secure-storage write
  // races process death and the credential is silently lost. The accept that
  // needs it runs in the MAIN isolate, whose heap does not see this map, so
  // durable storage is the only channel between them.
  final incomingRoomToken = (d['roomToken'] ?? '').toString();
  if (ringCallId.isNotEmpty && incomingRoomToken.isNotEmpty) {
    await rememberCallRoomTokenDurable(ringCallId, incomingRoomToken);
  }
  if (!ringInviteIsFresh(d)) {
    Analytics.capture('call_ring_suppressed_expired', {
      'call_id': ringCallId,
      'route': route,
      'token_expires_at': (d['tokenExpiresAt'] ?? '').toString(),
      'sent_at': (d['ts'] ?? '').toString(),
    });
    await _track(CallEvents.callIncomingShown, {
      'call_id': ringCallId,
      'route': route,
      'shown': false,
      'skip_reason': 'expired',
    });
    try { await FlutterCallkitIncoming.endCall(ringCallId); } catch (_) {}
    return;
  }
  // [AVACALL-RING-CANCEL-1] Don't surface a ring for a call whose caller already
  // cancelled. The cancel call-status can beat the ring push to this device (or
  // arrive on its heels); if we've already recorded a terminal status for this
  // callId, skip the CallKit UI entirely rather than ring for a caller who is
  // gone — the exact dead-end the 2026-07-20 incident produced.
  if (ringCallId.isNotEmpty && PushService.wasCallTerminated(ringCallId)) {
    Analytics.capture('call_ring_suppressed_cancelled', {
      'call_id': ringCallId,
      'route': route,
    });
    await _track(CallEvents.callIncomingShown, {
      'call_id': ringCallId,
      'route': route,
      'shown': false,
      'skip_reason': 'already_cancelled',
    });
    try { await FlutterCallkitIncoming.endCall(ringCallId); } catch (_) {}
    return;
  }
  final receivedAtMs = DateTime.now().millisecondsSinceEpoch;
  final sentAtMs = int.tryParse((d['ts'] ?? '').toString());
  final deliveryAgeMs = sentAtMs == null || sentAtMs <= 0
      ? null
      : (receivedAtMs >= sentAtMs ? receivedAtMs - sentAtMs : 0);
  // [CALL-LATE-RING-GUARD-1] A queued FCM ring can arrive after its matching
  // queued cancel, and Android may run those messages in separate background
  // lifetimes. In that ordering the in-memory terminal cache above is empty,
  // despite the CallRoom already being terminal (prod avatok-81da5f09 rang
  // about six seconds after the caller hung up). Do a small, fail-open durable
  // check only for materially delayed FCM delivery: the normal WS/fast FCM ring
  // remains latency-free, while a stale queue item cannot resurrect a dead call.
  const lateRingGuardMs = 3000;
  if (route != 'ws' && ringCallId.isNotEmpty &&
      deliveryAgeMs != null && deliveryAgeMs >= lateRingGuardMs) {
    final durableStatus = await PushService.fetchDurableCallStatus(
      ringCallId,
      timeout: const Duration(milliseconds: 900),
    );
    if (durableStatus != null) {
      _noteTerminalCall(ringCallId);
      Analytics.capture('call_ring_suppressed_durable_terminal', {
        'call_id': ringCallId,
        'route': route,
        'delivery_age_ms': deliveryAgeMs,
        'status': durableStatus,
      });
      await _track(CallEvents.callIncomingShown, {
        'call_id': ringCallId,
        'route': route,
        'shown': false,
        'skip_reason': 'durable_terminal',
        'delivery_age_ms': deliveryAgeMs,
      });
      try { await FlutterCallkitIncoming.endCall(ringCallId); } catch (_) {}
      return;
    }
  }
  AvaLog.I.log('call', 'showing incoming-call UI callId=${d['callId']} kind=${d['kind']} from=${d['fromName']}');
  // [CALL-4RINGS-1 2026-08-08] `callRingLifetimeMaxMs`, not `callRingLifetimeMs`.
  // The ring lease is per-call now (see ringInviteRemainingMs); a hard 20 000
  // ceiling here would end the native ring partway through the fourth cycle —
  // silencing the very ring that decides whether Ava takes over.
  final ringDurationMs = ringInviteRemainingMs(d, nowMs: receivedAtMs)
      .clamp(1, callRingLifetimeMaxMs)
      .toInt();
  Analytics.capture('call_incoming_received', {
    'call_id': ringCallId,
    'kind': (d['kind'] ?? 'audio').toString(),
    'state': route,
    'route': route,
    if (deliveryAgeMs != null) 'delivery_age_ms': deliveryAgeMs,
    'ring_remaining_ms': ringDurationMs,
  });
  IceCache.prefetch(); // warm TURN creds while the phone is still ringing
  // [GCALL-W4-RING] A group ring names the GROUP, with the starter underneath —
  // "Design team" is what the person needs to recognise, not one member's name.
  final bool isGroupRing = d['group'] == true || d['group'] == 'true';
  final String groupRingName = (d['groupName'] ?? '').toString();
  if (isGroupRing) {
    if (groupRingName.isNotEmpty) {
      PushService.rememberGroupRingName(ringCallId, groupRingName);
    }
    // [GCALL-TEL] The RECIPIENT half of a group ring. A call is a conversation
    // between two people, so it has to be findable from either end: the server
    // emits the send attributed to the starter's email, and this emits the
    // receive attributed to the recipient's (Analytics stamps email + phone on
    // every event). `from_uid`/`from_name` are what let you line the two
    // timelines up when a tester says "he called and my phone never rang".
    Analytics.capture('group_call_ring_received', {
      'call_id': ringCallId,
      'gid_hash': (d['gid'] ?? '').toString().hashCode.toString(),
      'group_name': groupRingName,
      'from_uid': (d['fromPub'] ?? '').toString(),
      'from_name': (d['fromName'] ?? '').toString(),
      'kind': (d['kind'] ?? 'audio').toString(),
      'route': route,
      if (deliveryAgeMs != null) 'delivery_age_ms': deliveryAgeMs,
      'ring_remaining_ms': ringDurationMs,
    });
    // [ADDCALL-3-UI] The RECEIVE half of a targeted invite (spec §5). The
    // Worker sets `invite:true` ONLY on `POST /api/groupcall/:gid/invite` — a
    // start-of-call broadcast leaves it unset — so this separates "someone
    // added me to a call already in progress" from "a group call started",
    // which are indistinguishable in `group_call_ring_received`.
    //
    // `escalation_id` rides the WS frame; the FCM push does not carry it, so it
    // is rebuilt from the gid, which is exactly how `escalationIdFor(groupId)`
    // computes the Worker's copy. Both routes therefore land on one key.
    //
    // There is no `groupcall_invite_accepted`/`_declined` counterpart on this
    // device and that is deliberate: a group ring has no receipt token and no
    // decline path (spec §5, accepted for v1). Do not "complete the pair" here
    // without the server half, or the funnel will claim knowledge it lacks.
    if (d['invite'] == true || d['invite'] == 'true') {
      final inviteGid = (d['gid'] ?? '').toString();
      Analytics.capture(CallEvents.groupcallInviteReceived, {
        'call_id': ringCallId,
        'gid_hash': inviteGid.hashCode.toString(),
        'escalation_id': (d['escalation_id'] ?? 'addcall:$inviteGid').toString(),
        'from_uid': (d['fromPub'] ?? '').toString(),
        'kind': (d['kind'] ?? 'audio').toString(),
        'route': route,
        if (deliveryAgeMs != null) 'delivery_age_ms': deliveryAgeMs,
        'ring_remaining_ms': ringDurationMs,
      });
    }
  }
  final params = CallKitParams(
    id: (d['callId'] ?? '').toString(),
    nameCaller: isGroupRing && groupRingName.isNotEmpty
        ? '$groupRingName · ${(d['fromName'] ?? 'AvaTOK')}'
        : (d['fromName'] ?? 'AvaTOK').toString(),
    appName: 'AvaTOK',
    handle: (d['fromPub'] ?? '').toString(),
    type: d['kind'] == 'video' ? 1 : 0, // 0 = audio, 1 = video
    // Use the absolute server expiry. A push delivered 15 seconds late may
    // ring for only the five seconds that remain.
    duration: ringDurationMs,
    textAccept: 'Accept',
    textDecline: 'Decline',
    avatar: callerAvatarFromPayload(d),
    extra: {
      'from': d['fromPub'] ?? '', // server sends 'fromPub' (FCM reserves 'from')
      'kind': d['kind'] ?? 'audio',
      'callId': d['callId'] ?? '',
      'fromName': d['fromName'] ?? 'AvaTOK',
      'callerAvatarUrl': callerAvatarFromPayload(d),
      'callerAvatarVersion': d['callerAvatarVersion'] ?? '',
      // [CALL-NATIVE-DECLINE-1] The CallKit plugin drops Dart events when the
      // app process is gone. Android's native bridge reads these fields straight
      // from the notification bundle and durably reports Decline via WorkManager.
      // The token is short-lived and scoped by the CallRoom DO to this call's
      // persisted callee; it is not an account credential.
      'nativeActionToken': d['nativeActionToken'] ?? '',
      'nativeActionExpiresAt': d['tokenExpiresAt'] ?? '',
      'nativeDeclineUrl': kNativeCallDeclineUrl,
      // [CALL-REL-R4-3] Second, independent carrier for the CallRoom join
      // credential. The primary path is the awaited secure-storage write above,
      // but a cold-start Accept comes back through CallKit/MainActivity, and
      // that bundle survives process death by construction — so carrying the
      // token here gives the accept a recovery path that does not depend on the
      // background isolate having lived long enough to finish its write.
      // Same short-lived, call-scoped credential; not an account credential.
      'roomToken': d['roomToken'] ?? '',
      // [TRACE-ID-1] Carry the caller's correlation id through CallKit so the
      // callee's CallSession stitches to the same trace as the caller + Worker.
      'trace_id': d['trace_id'] ?? '',
      // [GCALL-W4-RING] Group-call ring. These two fields are what make Accept
      // open the conference screen instead of the 1:1 one — everything above is
      // shared, so a group call now rings through exactly the same CallKit path
      // that 1:1 calls have always used, rather than the content-less chat chime
      // that used to be a group call's only announcement.
      'group': d['group'] == true ? 'true' : '',
      'gid': (d['gid'] ?? '').toString(),
      'groupName': (d['groupName'] ?? '').toString(),
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
  // [ONERING-1 2026-08-02] ONE ring surface at a time.
  //
  // When the app is already foregrounded we push the branded screen onto the
  // live navigator further down. Registering the native ring as well put
  // Android's own heads-up banner — with its own Accept/Decline pair — on top
  // of our screen: two call UIs for one call. The comment below used to call
  // this a "user-silent CallKit registration"; it was never silent.
  //
  // The suppression is deliberately narrow. It applies ONLY when the app is
  // foregrounded and the branded screen is definitely the surface we are about
  // to show. Every other case still registers CallKit, because there it is
  // load-bearing: it owns the ringtone, it survives the app being killed, and
  // it is the fallback wherever Android denies a full-screen intent.
  // [CALL-REL-R4-B 2026-08-03] "Is the app in front?" used to be the exact
  // equality `lifecycle == 'resumed'`, and Android does not honour it: while it
  // launches CallKit's own full-screen-intent activity over an open app,
  // MainActivity reports `paused`. Prod `avatok-cb1618e6` rang with
  // `lifecycle=paused`, so the suppression did not fire, CallKit was registered
  // ALONGSIDE the branded screen, and its heads-up notification was still in the
  // shade when the user hit Accept — the "ring starts in the header after I
  // answer" report.
  //
  // V2 also accepts `inactive` (a transient hand-off, engine and navigator both
  // alive) and a `paused` app that was resumed within `_kAppFrontGraceMs`. Both
  // still require a live navigator: without one there is nothing to push the
  // branded screen onto, and suppressing CallKit would leave no ring at all.
  final appFrontReason = _resolveAppFrontReason(lifecycle);
  final appIsInFront = appFrontReason != null;
  final relaxedFront = appIsInFront && appFrontReason != 'resumed';
  final brandedWillShowInApp = appIsInFront &&
      (RemoteConfig.brandedIncomingUi ||
          (RemoteConfig.businessCallUx && (d['via'] ?? '') == 'dialpad')) &&
      !PushService.wasCallTerminated(ringCallId) &&
      navigatorKey.currentState != null;
  final suppressOsRing =
      brandedWillShowInApp && RemoteConfig.suppressOsRingInForeground;
  if (!suppressOsRing) {
    try {
      await FlutterCallkitIncoming.showCallkitIncoming(params);
    } catch (e) {
      showErr = e;
    }
  } else {
    // Suppressing on a RELAXED reading is a guess. Getting it wrong would mean
    // no ring at all, which is far worse than the bug being fixed — so verify
    // shortly and register CallKit after all if the app is not really in front.
    // Worst case is a slightly late OS ring; never a silent one.
    if (relaxedFront) {
      unawaited(_verifyForegroundRingOrFallback(
        callId: ringCallId, params: params, route: route,
        frontReason: appFrontReason,
      ));
    }
    // CallKit owns the ringtone, so suppressing it means we own it now. This is
    // the same in-app player the ring-audibility path already uses when the OS
    // ring is inaudible, so the sound path is not new code.
    unawaited(_startRingtoneFallback(ringCallId));
    Analytics.capture('call_os_ring_suppressed', {
      'call_id': ringCallId,
      'route': route,
      'reason': 'branded_in_app_foreground',
      // [CALL-REL-R4-B] Which reading suppressed the OS ring. 'resumed' is the
      // pre-existing strict case; anything else means V2 relaxed it and the
      // fallback below is armed. A rise in `call_os_ring_fallback_registered`
      // against a given front_reason is the signal that the grace is too loose.
      // Non-null by construction here: suppressOsRing implies appIsInFront (the
      // analyzer proves it — a `?? 'none'` on this line is flagged dead).
      'front_reason': appFrontReason,
      'relaxed_front': relaxedFront,
    });
  }
  await _track(CallEvents.callIncomingShown, {
    'call_id': (d['callId'] ?? '').toString(),
    'kind': (d['kind'] ?? 'audio').toString(),
    'route': route,
    // [ONERING-1] `shown` means "a ring surface was raised", NOT "CallKit ran".
    // A suppressed OS ring still shows the user a ring — the branded screen —
    // so reporting shown:false here would look like a missed ring in the
    // dashboards. `os_ring_suppressed` is what distinguishes the two.
    'shown': suppressOsRing || showErr == null,
    'os_ring_suppressed': suppressOsRing,
    // [CALL-REL-R4-B] The prod tell for this bug was `os_ring_suppressed=false`
    // with `lifecycle=paused` on an app the owner had open. `front_reason` makes
    // that readable without inferring it: 'none' = we judged the app not in front.
    'front_reason': appFrontReason ?? 'none',
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
  // [CALL-PREWARM-1 2026-08-16] Right after the ring surface is confirmed
  // shown (i.e. accept is now reachable), start warming this callee's media
  // path — ICE credentials + an SFU seat — so accept only has to publish +
  // pull. 1:1 only: group rings use the separate conference join, not
  // `/api/callsfu/:room/join`. Fire-and-forget and exception-proof by
  // construction — `CallPrewarm.start` itself never throws and is a no-op
  // while `callPrewarmOnRingV1` is off, but this call must never be able to
  // affect the ring path even if that ever changes.
  if (!isGroupRing) {
    try {
      CallPrewarm.instance.start(ringCallId);
    } catch (_) {/* prewarm must never affect the ring path */}
  }
  // A receipt means a user-visible ring surface was successfully raised—not
  // merely that a transport callback ran. Centralizing it here prevents WS,
  // foreground FCM and background FCM from reporting different semantics.
  final receiptToken = (d['ringReceiptToken'] ?? '').toString();
  if (receiptToken.isNotEmpty) {
    unawaited(PushService.reportRinging(ringCallId, receiptToken, route: route));
  }
  // [CALL-REL-9] REL-10: capture ring-audibility signals AT RING TIME and,
  // gated by callRingAudibilityV1, start the in-app fallback ringtone.
  // Unawaited — telemetry/fallback must never delay or block the ring path.
  unawaited(_emitRingAudibilityAndMaybeFallback(
    d,
    // [ONERING-1] A suppressed OS ring is NOT a shown CallKit ring. Reporting
    // true here would tell the audibility probe the OS is making noise when we
    // are the ones playing it.
    callkitShown: !suppressOsRing && showErr == null,
    route: route,
    lifecycle: lifecycle,
    fsiGranted: fsiGranted,
  ));
  // Preserve the pre-instrumentation contract: a CallKit failure still throws.
  if (showErr != null) throw showErr;
  // [AVACALL-INUI-1] Branded incoming-call UI for ALL AvaTOK app-to-app calls
  // (owner decision 2026-07-20). The polished IncomingBusinessCallScreen
  // (avatar + Accept · Decline · Block · Send-to-Ava) now replaces the cheap
  // native CallKit green screen for FRIEND calls as well as business/dialpad
  // calls — the missing avatar on a plain friend call was the "unbranded" tell
  // in the prod incident. The native CallKit ring posted just above is KEPT: it
  // owns the ringtone, it is what `acceptRingingCall` reads back via
  // `FlutterCallkitIncoming.activeCalls()`, and it is the forced fallback where
  // Android won't grant a full-screen activity. This branded screen is layered
  // on top of it, exactly as the DIALPAD-BIZ path always was.
  //
  // Gated by `brandedIncomingUi` (default TRUE). When that flag is OFF we
  // preserve the older behaviour byte-for-byte: branded only for `businessCallUx`
  // + a `via:'dialpad'` marker. When ON, every AvaTOK ring (type=='call') is
  // branded regardless of `via`.
  //
  // Foreground calls use the live navigator. Background/locked calls now have
  // ONE Android owner: CallKit's notification launches MainActivity with the
  // `avatok.incoming_call_tap` payload, and MainActivity routes that payload to
  // this same branded screen. Do not post a second local FSI here — that was the
  // source of the duplicate ringtone/notification and stale "is calling" card.
  final brandedOn = RemoteConfig.brandedIncomingUi ||
      (RemoteConfig.businessCallUx && (d['via'] ?? '') == 'dialpad');
  if (brandedOn && !PushService.wasCallTerminated(ringCallId)) {
    // [CALL-ACCEPT-LIVENESS-1 2026-08-06] Do not paint an Accept button while a
    // call is already live.
    //
    // The WS ring lane and the FCM foreground lane BOTH check
    // `callIsGenuinelyActive()`, signal busy and return (`call_incoming_autobusy`
    // — five sites, all above). This branded/FSI lane did not, so on 2026-08-05
    // the owner got a full-screen Accept for `avatok-7e634735` while he was mid
    // call, even though the app had already told the caller he was busy. He
    // tapped it, and the accept path tore down his working call.
    //
    // Auto-busy is only honest if EVERY ring surface honours it. Anything else
    // is telling the caller "he's busy" and the callee "answer this".
    if (callIsGenuinelyActive()) {
      Analytics.capture('call_branded_fsi_suppressed', {
        'call_id': ringCallId,
        'reason': 'on_another_call',
      });
      return;
    }
    // [CALL-REL-R4-B] MUST use the same reading as the suppression above. If
    // these two ever disagree — suppress the OS ring but decline to push the
    // branded screen — the call rings on no surface at all.
    if (appIsInFront) {
      // Use the same reservation gate as native taps and cold-start payloads.
      unawaited(_routeToBrandedIncoming(d));
    }
  }
}

class PushService {
  /// [CALL-STATUS-WSLANE-1 2026-08-14] Terminal call-status (cancel / bye /
  /// decline / …) delivered over the live InboxDO WebSocket — the same fast
  /// lane the RING already uses ([WS-RING-1]), closing a delivery asymmetry:
  /// the ring reached an online callee in <1s over this socket, but the
  /// caller's CANCEL only travelled via CallRoom sockets (which a ringing,
  /// not-yet-accepted callee is never attached to) plus the FCM backstop,
  /// which Android throttles after bursts of calls. Prod call avatok-9f407abf
  /// (2026-08-14): caller hung up at :21, the callee rang until his own 28s
  /// window expired at :31 — the cancel never arrived in time.
  ///
  /// Routes through the SAME two sinks as the foreground FCM 'call-status'
  /// branch: `callStatusBus` for a live caller session, and the ring reducer
  /// (`applyRingTransition`, seq-deduped) for a ringing callee — whichever of
  /// WS/FCM lands second is a no-op, exactly like the ring's dual delivery.
  static Future<void> handleWsCallStatus(Map<String, dynamic> f) async {
    final callId = (f['callId'] ?? '').toString();
    final status = (f['status'] ?? '').toString();
    if (callId.isEmpty || status.isEmpty) return;
    final seq = int.tryParse((f['seq'] ?? '').toString());
    Analytics.capture('call_status_ws_received', {
      'call_id': callId,
      'status': status,
      if (seq != null) 'seq': seq,
    });
    callStatusBus.add((
      callId: callId,
      status: status,
      busyReason: null,
      receptionistEnabled: false,
      pronoun: null,
      activationMode: null,
      noAnswerReason: null,
    ));
    await applyRingTransition(
      callId, status,
      seq: int.tryParse((f['seq'] ?? '').toString()),
      source: 'inbox_ws',
    );
  }

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
    if (_suppressSameCallerRetry(incomingId, fromPub)) {
      _signalStatus(incomingId, 'busy', fromPub,
          busyReason: 'active_call', receptionistEnabled: true);
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
    // [GCALL-W4-BUSY] Being in a GROUP call counts as being on a call. The busy
    // guards above only ever counted 1:1 sessions, so a conference participant
    // still got rung for a 1:1 — and answering it did not leave the conference,
    // leaving them nominally in two calls with one microphone.
    if (CloudflareConferenceController.activeGid != null) {
      _signalStatus(incomingId, 'busy', fromPub,
          busyReason: 'active_call', receptionistEnabled: true);
      Analytics.capture('call_incoming_autobusy',
          {'call_id': incomingId, 'kind': kind, 'busy_reason': 'in_group_call'});
      return;
    }
    if (gInCall) {
      // Stale gInCall — clear so we ring instead of silently rejecting (same
      // recovery as the FCM branch).
      gInCall = false;
      gActiveCallId = null;
      gInCallSince = 0;
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
  static final Map<String, int> _recentIncomingByCaller = {};
  static const int _sameCallerRetryWindowMs = 20000;
  static bool _seenIncoming(String callId) {
    if (callId.isEmpty) return false;
    final now = DateTime.now().millisecondsSinceEpoch;
    _recentIncoming.removeWhere((_, t) => now - t > 60000);
    if (_recentIncoming.containsKey(callId)) return true;
    _recentIncoming[callId] = now;
    return false;
  }

  /// A caller retrying with a fresh call id is still the same ring. Suppress it
  /// while we are already talking to that caller, and suppress rapid retries
  /// after the first ring so a stale fourth Accept cannot replace a live call.
  static bool _suppressSameCallerRetry(String callId, String caller) {
    if (caller.isEmpty) return false;
    final now = DateTime.now().millisecondsSinceEpoch;
    _recentIncomingByCaller.removeWhere((_, t) => now - t > _sameCallerRetryWindowMs);
    final active = CallSessionManager.instance.current;
    final activePeer = active != null && !active.isEnded ? active.config.seed : '';
    final sameLiveCaller = callIsGenuinelyActive() && activePeer == caller;
    final previous = _recentIncomingByCaller[caller];
    _recentIncomingByCaller[caller] = now;
    // [CALL-REDIAL-BUSY-1 2026-08-09] `rapid_retry` only means anything while a
    // ring or call from that caller is actually IN PROGRESS (its purpose: a
    // stale fourth Accept must not replace a live call). On an IDLE device it
    // was eating legitimate redials: prod 2026-08-08, avatok-8eb20bdc — the
    // caller's two previous attempts had already died at 0s, the callee was on
    // no call and hearing no ring, and the third attempt was suppressed +
    // busy-signalled purely because it came within the 20s window. After a
    // dropped call, an immediate redial is the single most natural thing a
    // caller does; it must ring.
    final ringOrCallInProgress = callIsGenuinelyActive() ||
        (gIncomingRingingCallId != null && gIncomingRingingCallId != callId);
    if (sameLiveCaller ||
        (previous != null && callId != gActiveCallId && ringOrCallInProgress)) {
      Analytics.capture('call_same_caller_retry_suppressed', {
        'call_id': callId,
        'caller': caller,
        'reason': sameLiveCaller ? 'already_in_call' : 'rapid_retry',
      });
      return true;
    }
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
  ///
  /// [CALL-REL-9] The audibility params are OPTIONAL and purely additive — the
  /// original near-instant, audibility-free call this file fires the moment a
  /// ring push lands is UNCHANGED (see the two existing call sites above). A
  /// SECOND call carrying the compact audibility fields follows once the
  /// on-device probe completes, from [_emitRingAudibilityAndMaybeFallback].
  /// The server re-validates the stored ring-receipt token but does not
  /// consume it (worker/src/do/call_room.ts `device-ringing`), so a repeat
  /// POST with the same token is safe.
  static Future<void> reportRinging(
    String callId,
    String ringReceiptToken, {
    String? audible,
    String? ringerMode,
    bool? dndBlocking,
    int? ringVolume,
    int? ringVolumeMax,
    String? route,
    // [CALL-4RINGS-1 2026-08-08] Which ring CYCLE this receipt is for (1-based,
    // strictly increasing within one call), and whether that cycle boundary was
    // MEASURED or assumed from a `ringCycleMs` timer. Both optional: the very
    // first receipt — the latency-critical one that starts the caller's ringback
    // — still carries neither and is unchanged. Only a receipt with a ringIndex
    // is a countable ring on the server.
    int? ringIndex,
    bool? derived,
  }) async {
    if (callId.isEmpty || ringReceiptToken.isEmpty) return;
    try {
      final client = HttpClient();
      final uri = Uri.parse('https://$kSignalingHost/api/call/ringing');
      final request = await client.postUrl(uri);
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode({
        'callId': callId,
        'ringReceiptToken': ringReceiptToken,
        if (audible != null) 'audible': audible,
        if (ringerMode != null) 'ringerMode': ringerMode,
        if (dndBlocking != null) 'dndBlocking': dndBlocking,
        if (ringVolume != null) 'ringVolume': ringVolume,
        if (ringVolumeMax != null) 'ringVolumeMax': ringVolumeMax,
        if (route != null) 'route': route,
        if (ringIndex != null) 'ringIndex': ringIndex,
        if (derived != null) 'derived': derived,
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
    // [CALL-REL-R4-B] Start tracking when we were last actually in front. The
    // ring path needs "how long ago were we resumed", which the point-in-time
    // `lifecycleState` cannot answer, and an observer only sees transitions that
    // happen after it registers — so this must be armed at init, not at ring
    // time. Idempotent, and a no-op where there is no binding.
    _AppFrontTracker.I.ensureRegistered();
    if (Platform.isAndroid) {
      // [CALL-NOTIF-OWNER-1] The build-locked CallKit patch routes notification
      // body/full-screen taps into MainActivity instead of the plugin's green
      // CallkitIncomingActivity. Drain a cold-start tap and listen for warm taps
      // so every route opens the same branded Flutter screen.
      const tapChannel = MethodChannel('avatok/incoming_call_tap');
      tapChannel.setMethodCallHandler((call) async {
        if (call.method != 'incomingCallTapped' || call.arguments is! Map) return;
        await _routeToBrandedIncoming(
            Map<String, dynamic>.from(call.arguments as Map));
      });
      try {
        final pending =
            await tapChannel.invokeMapMethod<String, dynamic>('getPending');
        if (pending != null) unawaited(_routeToBrandedIncoming(pending));
      } catch (_) {/* native bridge unavailable on an older build */}
    }
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
        android: AndroidInitializationSettings(_kNotifIcon),
      ),
      // [NOTIF-ACTIONS-1] Same handler for the app-is-dead case.
      onDidReceiveBackgroundNotificationResponse: notificationActionBackground,
      onDidReceiveNotificationResponse: (resp) {
        // [AVACALL-INUI-2] A tapped / FSI-launched branded incoming-call
        // notification routes to IncomingBusinessCallScreen, not the inbox.
        if (_maybeRouteBrandedIncoming(resp.payload)) return;
        // [NOTIF-ACTIONS-1] Message actions, when the app IS alive. Handled here
        // rather than falling through to _onNotifTap, which would treat a Reply
        // as a body tap and open the thread — throwing the typed text away.
        final act = resp.actionId ?? '';
        if (act == _kActReply || act == _kActRead || act == _kActMute) {
          unawaited(_runNotifAction(resp));
          return;
        }
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
    // [NOTIF-STYLE-1] Reading a chat IN THE APP must take that chat's
    // notification out of the shade. This never mattered before, because every
    // message reused the single id 8000 and the next one simply overwrote
    // whatever stale banner was sitting there. Now each conversation owns its
    // own notification and its own stored message list, so without this hook
    // nothing would ever clear them: the bundle would keep counting messages
    // already read, and re-expand them on the next push.
    //
    // `ActiveThread.enter` is the one point every thread flavour reaches (DM,
    // group, voicemail) — see chat_thread/setup.dart `_markRead`. The inbox
    // screen prefixes its key with 'inbox:', so strip that to recover the conv.
    ActiveThread.onEnter = (key) {
      final conv = key.startsWith('inbox:') ? key.substring('inbox:'.length) : key;
      unawaited(_clearShadeThread(conv));
    };
    final androidLocal = _local
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    await androidLocal?.createNotificationChannel(_msgChannel);
    await androidLocal?.createNotificationChannel(_callsChannel);
    await androidLocal?.createNotificationChannel(_incomingCallChannel); // [AVACALL-INUI-2]
    // [NOTIF-ACTIONS-1] The quiet channel muted conversations post to. Created in
    // BOTH isolates because whichever one draws a banner first must find it —
    // posting to a channel that does not exist yet is silently dropped by Android.
    await androidLocal?.createNotificationChannel(_msgMutedChannel);
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
      final p = launch!.notificationResponse?.payload;
      // [AVACALL-INUI-2] Cold-started by a branded incoming-call full-screen
      // intent (locked / killed) → open the branded screen, not the inbox.
      if (!_maybeRouteBrandedIncoming(p)) _onNotifTap(p);
    }
    FirebaseMessaging.onMessage.listen((m) {
      final d = m.data;
      AvaLog.I.log('push', 'FCM received (foreground) type=${d['type']} callId=${d['callId'] ?? ''}');
      Analytics.capture('fcm_fg_received', {
        'type': (d['type'] ?? '').toString(),
        'callId': (d['callId'] ?? '').toString(),
      });
      // [CALL-PRESENCE-1 2026-08-07] An FCM message reaching the Dart isolate is
      // PROOF this device is awake and reachable right now — the single best
      // evidence we ever get, and the one the previous design threw away. It is
      // especially valuable for a phone that has been dozing: the 25s ping tick
      // is exactly what Android suspends, so a doze'd-but-wakeable device would
      // otherwise read as `stale` on every call. Forced (bypasses the cadence
      // throttle) and fire-and-forget — it cannot delay handling this push.
      PresenceBeat.beat('push', force: true);
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
          activationMode: d['activation_mode']?.toString(),
          noAnswerReason: d['no_answer_reason']?.toString(),
        ));
        // [CALL-REDUCER-1] If we're the callee still ringing, tear the ring
        // surface down — via the ONE reducer, which also enforces ordering so a
        // late/duplicate FCM redelivery can't re-run teardown or undo a newer
        // transition. `seq` is the server's monotonic transition_sequence.
        unawaited(applyRingTransition(
          callId, status,
          seq: int.tryParse((d['seq'] ?? '').toString()),
          source: 'fcm_fg',
        ));
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
      // [AVA-UPDATE-PUSH-1] A new build was just published and the app is in the
      // FOREGROUND (in use). Show the in-app "Update available" dialog immediately
      // — no banner, no waiting for the 30-min timer or a resume. UpdateService
      // re-checks the authoritative latestAppBuild and stays silent if this device
      // already carries it.
      if (d['type'] == 'app_update') {
        final b = int.tryParse((d['build'] ?? '').toString()) ?? 0;
        Analytics.capture('app_update_push_fg', {'build': b});
        unawaited(UpdateService.onUpdatePush(build: b));
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
      // [CALLREC-UX-1] Foreground twin of the bg branch: banner (so the tap can
      // deep-link) + a cursor sync so the recording's Inbox row lands now.
      if (d['type'] == 'call_recording') {
        unawaited(_showCallRecordingNotif(d));
        SyncHub.I.syncFromPush();
        return;
      }
      if (d['type'] == 'group_invite') {
        // Foreground: show the "added to group" banner + refresh sync so the new
        // group thread appears in the list.
        _showGroupInviteNotif(d);
        SyncHub.I.ensureConnected();
        // [GRP-W3-RESYNC] …and actually pull the group. The handler used to only
        // show a banner and poke the socket, neither of which re-reads the member
        // cache, so being added to a group still needed a relaunch to show up.
        final inviteConv = (d['conv'] ?? d['gid'] ?? '').toString();
        unawaited((inviteConv.isNotEmpty
                ? GroupApi.refresh(inviteConv).then((_) {})
                : GroupApi.sync().then((_) {}))
            .catchError((_) {/* resume-resync is the backstop */}));
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
        final retryCaller = (d['fromPub'] ?? d['from'] ?? '').toString();
        if (_suppressSameCallerRetry(incomingId, retryCaller)) {
          _signalStatus(incomingId, 'busy', retryCaller,
              busyReason: 'active_call', receptionistEnabled: true);
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

  /// Tell the caller a call was declined / busy.
  ///
  /// [CALL-TERMINAL-BCAST-1 2026-08-01] There is now exactly ONE client signalling
  /// path: POST /api/call-status. The Worker hands the status to the CallRoom DO,
  /// which fans it out over the caller's ALREADY-OPEN WebSocket (fast, sub-100ms)
  /// and enqueues the FCM push as the durable backstop.
  ///
  /// The old "fast path" — a throwaway `ctl-<epoch>` WebSocket opened here, one
  /// frame written, socket closed 800ms later — has been DELETED. It was the worst
  /// kind of optimisation: `WebSocketChannel.connect` is lazy, so a DNS/TLS/upgrade
  /// failure surfaced asynchronously on `sink.done` and this try/catch (which only
  /// catches synchronous throws) swallowed it whole. It had no ack, no retry and no
  /// telemetry, so when it silently failed — routinely, on a cold FCM-woken isolate
  /// that cannot finish a TLS handshake in 800ms — nothing recorded it and the
  /// decline fell back to the 5-second FCM queue. That is the prod bug
  /// (call avatok-f0c0ef5c: decline at 01:31:47.66, caller notified 01:31:53.06).
  /// Two competing status paths also made ordering impossible to reason about.
  ///
  /// Everything the socket carried is already in the HTTP body — `busy_reason`,
  /// `receptionist_enabled`, `pronoun` — so nothing is lost. Verified: the DO reads
  /// no metadata that arrived only over that socket.
  /// [CALL-CMD-IDEMPOTENT-2] `intent` names the USER'S ACTION when several
  /// actions share one wire status — decline, report_spam and block all signal
  /// `decline`. `actionInstanceId` must be minted ONCE at the tap and reused
  /// across every retry of THAT tap; callers that omit it get a per-call-stable
  /// value, which preserves the old collapse-retries behaviour for paths where
  /// only one such action is possible.
  static Future<bool> _signalStatus(String callId, String status, String callerNpub,
      {String? busyReason, bool receptionistEnabled = false, String? pronoun,
      String? intent, String? actionInstance}) {
    if (callId.isEmpty) return Future<bool>.value(false);
    final actionInstanceId = actionInstance ?? 'single';
    // [BUSY-CARD-1] When we auto-busy a caller, attach why we're busy + whether Ava
    // can take a message, so the CALLER renders the personalized busy card instead
    // of a cold "User is busy". Additive: old callers ignore the extra fields.
    final extra = <String, dynamic>{};
    if (status == 'busy' && busyReason != null && busyReason.isNotEmpty) {
      extra['busy_reason'] = busyReason;
      extra['receptionist_enabled'] = receptionistEnabled;
      if (pronoun != null && pronoun.isNotEmpty) extra['pronoun'] = pronoun;
    }
    if (callerNpub.isEmpty) {
      // No caller uid = nothing to signal to. Record it: previously the ctl- socket
      // masked this case, so a decline could vanish with no trace at all.
      Analytics.capture('call_status_signal_skipped', {
        'call_id': callId, 'status': status, 'reason': 'no_caller_uid',
      });
      return Future<bool>.value(false);
    }
    final t0 = DateTime.now().millisecondsSinceEpoch;
    // [CALL-CMD-IDEMPOTENT-2 2026-08-01] One id per USER ACTION, not per HTTP
    // attempt. A retry, an FCM action replay, a double-tap or CallKit
    // double-firing all reuse it, so the server collapses them into a single
    // transition instead of each producing a new sequence and a fresh
    // broadcast. Deliberately NOT random per attempt: that would make every
    // duplicate look like a distinct command, which is the bug it prevents.
    //
    // FIXED: this was `$callId:$status`, which COLLIDED. Report Spam, Block and
    // plain Decline all signal the status `decline`, so on one call they
    // produced the same id — and the second real, distinct user action was
    // silently swallowed as a "replay". Reporting someone after declining them
    // would have looked like it worked and done nothing.
    //
    // The id now includes the intent AND a per-action instance, so two
    // different actions on one call are distinct while retries of the SAME
    // action still collapse. `intent` defaults to the status for callers that
    // do not distinguish.
    final commandId = '$callId:${intent ?? status}:$actionInstanceId';
    final command = switch (status) {
      'decline' || 'declined' => 'decline_call',
      'decline_ava' => 'handoff_to_receptionist',
      'decline_vm' => 'offer_voicemail',
      'cancel' => 'cancel_call',
      'bye' || 'hangup' || 'ended' => 'end_call',
      _ => null,
    };
    final future = command != null
        ? ApiAuth.postJson(kCallCommandUrl, {
            'callId': callId, 'command': command, 'commandId': commandId,
          })
        : ApiAuth.postJson(kCallStatusUrl, {
            'to': callerNpub, 'callId': callId, 'status': status,
            'commandId': commandId, ...extra,
          });
    return future.then((res) {
      // Telemetry for the ONE remaining path, split by leg so a regression is
      // diagnosable: did the DO persist it, and did it reach a live socket?
      var socketsSent = -1, socketsSeen = -1;
      var alreadyTerminal = false;
      try {
        final j = jsonDecode(res.body);
        if (j is Map) {
          socketsSent = (j['sockets_sent'] as num?)?.toInt() ?? -1;
          socketsSeen = (j['sockets_seen'] as num?)?.toInt() ?? -1;
          alreadyTerminal = j['already_terminal'] == true;
        }
      } catch (_) {/* non-JSON body — still record the status code */}
      Analytics.capture('call_status_signal_sent', {
        'call_id': callId,
        'status': status,
        'to_uid': callerNpub,
        'http_status': res.statusCode,
        'sockets_seen': socketsSeen,
        'sockets_sent': socketsSent,
        'already_terminal': alreadyTerminal,
        'ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      return res.statusCode >= 200 && res.statusCode < 300;
    }).catchError((Object e) {
      Analytics.capture('call_status_signal_failed', {
        'call_id': callId, 'status': status, 'to_uid': callerNpub,
        'error': e.toString(),
        'ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      return false;
    });
  }

  /// React to taps on the native call UI (accept / decline / timeout).
  static void _listenCallkit() {
    FlutterCallkitIncoming.onEvent.listen((event) {
      if (event == null) return;
      switch (event.event) {
        case Event.actionCallAccept:
          // The branded FSI is a separate notification from CallKit. Accepting
          // the native action must clear it too or it remains tappable after the
          // call has already moved on.
          unawaited(_dismissBrandedFsi());
          IceCache.prefetch(); // accept tapped → call screen is next; warm TURN now
          final acc = event.body['extra'];
          var accId = '';
          if (acc is Map) {
            accId = (acc['callId'] ?? '').toString();
            // CALL-GLARE-1: dedupe duplicate accept events for the same call.
            if (_onceCallEvent(accId, 'accepted')) {
              Analytics.capture('call_incoming_accepted', {
                'call_id': accId,
                'kind': acc['kind'] == 'video' ? 'video' : 'audio',
              });
            }
            // [CALL-REL-9] Stop the in-app ringtone fallback (if it was playing).
            unawaited(_stopRingtoneFallback(accId));
          }
          // CALLFIX-R6: Clear glare state when accept is tapped
          gIncomingRingingFrom = null;
          gIncomingRingingCallId = null;
          // [CALL-ACCEPT-FLASH-1] This used to go straight to the raw
          // `_openCall`, which re-runs its OWN blocking `_claimHumanAccept` —
          // a second claim POST on top of whatever the branded in-app screen
          // may already be running for the same call — and never told the
          // branded IncomingBusinessCallScreen (if it happened to also be
          // mounted, e.g. accept tapped from the notification while the app is
          // foregrounded on the branded ring) that its ring was over, so it
          // survived indefinitely underneath CallScreen. Routing through the
          // shared `acceptRingingCall` gets the single non-blocking claim; the
          // explicit `ringEndedBus` post below is the same signal
          // `applyRingTransition` uses to close that screen (it already
          // listens for ANY status on this call's `ringEndedBus`), which
          // `acceptRingingCall`'s own reducer path never has reason to send
          // for 'accepted' since it isn't a terminal ring status.
          if (accId.isNotEmpty) {
            ringEndedBus.add((callId: accId, status: 'accepted'));
            unawaited(acceptRingingCall(
              accId,
              fallbackExtra: acc is Map ? acc : null,
            ));
          } else {
            // No callId to route through the shared helper — fall back to the
            // raw open so a malformed payload still has a chance to connect.
            unawaited(_openCall(event.body['extra'])); // CALLFIX-15
          }
          break;
        case Event.actionCallDecline:
          final extra = event.body['extra'];
          if (extra is Map) {
            final declineId =
                (extra['callId'] ?? event.body['id'] ?? '').toString();
            if (_wasProgrammaticCallkitEnd(declineId)) {
              // A reducer-owned native teardown is not a second user intent.
              // Never let an OEM's synthetic decline overwrite a receptionist,
              // voicemail, or agent handoff already in flight.
              Analytics.capture('call_programmatic_decline_suppressed', {
                'call_id': declineId,
              });
              unawaited(_stopRingtoneFallback(declineId));
              gIncomingRingingFrom = null;
              gIncomingRingingCallId = null;
              break;
            }
            // v2 Mode C: if the owner enabled "let Ava take calls I decline",
            // signal 'decline_ava' so the caller hands off to the receptionist
            // instead of getting a plain decline. Else signal a normal decline.
            // ignore: unawaited_futures
            // [CALL-OBS-1] This is the OS notification's Decline action — the
            // same event some Motorola builds emit for a programmatic endCall()
            // on a call the user just ACCEPTED. Labelling it at the emission
            // site is what makes phantom declines countable.
            _declineRouting(extra, origin: 'callkit_native');
            // [CALL-REL-9] Stop the in-app ringtone fallback (if it was playing).
            unawaited(_stopRingtoneFallback((extra['callId'] ?? '').toString()));
          }
          // CALLFIX-R6: Clear glare state when decline is tapped
          gIncomingRingingFrom = null;
          gIncomingRingingCallId = null;
          break;
        case Event.actionCallTimeout:
          final ex = event.body['extra'];
          if (ex is Map) {
            _logMissed(ex, origin: 'os_timeout');
            // [CALL-REL-9] Stop the in-app ringtone fallback (if it was playing).
            unawaited(_stopRingtoneFallback((ex['callId'] ?? '').toString()));
            // [PIV-2 2026-08-02] An unanswered ring is a ring that ENDED, so it
            // must go through the reducer as well — otherwise the branded
            // full-screen ring survived a timeout exactly the way it survived a
            // decline. Same root cause, same one-line fix.
            unawaited(applyRingTransition(
              (ex['callId'] ?? '').toString(), 'missed',
              source: 'callkit_timeout',
            ));
          }
          break;
        case Event.actionCallEnded:
          // [CALL-REL-9] A call ending — for any reason (remote hangup, our own
          // programmatic endCall, another leg winning glare, etc.) — must never
          // leave the in-app fallback ringtone looping into what is now either
          // a connected call or a dead one. This event was previously a no-op
          // here, which was the gap: `actionCallAccept`/`Decline`/`Timeout` all
          // stopped the fallback, but a call that simply ENDED (without going
          // through one of those three) did not.
          final endedExtra = event.body['extra'];
          final endedId = (endedExtra is Map
                  ? (endedExtra['callId'] ?? '')
                  : (event.body['id'] ?? event.body['callId'] ?? ''))
              .toString();
          unawaited(_stopRingtoneFallback(endedId.isEmpty ? null : endedId));
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
  static Future<void> declineIncomingCall(Map extra) =>
      _declineRouting(extra, origin: 'user_tap');

  /// [DIALPAD-BIZ-CALLS Phase C] "Send to Ava AI Agent" from the in-app named
  /// incoming-business-call screen. Signals `decline_agent` to the CALLER
  /// (fast signaling-room WS + durable /api/call-status, same dual path as a
  /// decline) — the caller's CallSession then hands its leg to the agent flow
  /// (routing_decision reason MANUAL_SEND_TO_AGENT, plan §13). Old caller
  /// clients that don't know `decline_agent` end the ring like a plain
  /// decline-shaped status; they never dead-end.
  static Future<void> sendToAgentIncomingCall(Map extra) async {
    unawaited(_dismissBrandedFsi()); // [AVACALL-INUI-2] clear the lock-screen FSI banner
    final callId = (extra['callId'] ?? '').toString();
    final from = (extra['from'] ?? '').toString();
    // [CALL-REL-9] This branded-screen action ends the ring but never routes
    // through `_declineRouting` or the CallKit event listener, so it needs its
    // own stop — otherwise "Send to Ava" left the fallback looping.
    unawaited(_stopRingtoneFallback(callId));
    _signalStatus(callId, 'decline_agent', from);
    // CALL-GLARE-1: same dedupe key as decline — the two are mutually exclusive
    // outcomes of one ring, and CallKit can double-fire either.
    if (_onceCallEvent(callId, 'declined')) {
      Analytics.capture('call_incoming_declined', {
        'call_id': callId,
        'routed_to': 'decline_agent',
        'origin': 'user_tap',
      });
    }
    _logMissed(extra, origin: 'sent_to_agent');
  }

  /// Decline routing.
  ///
  /// [CALL-DECLINE-IS-TERMINAL-1 2026-08-01] OWNER RULING A: a plain Decline
  /// ALWAYS signals `decline`, which ends the caller's leg immediately. It NEVER
  /// silently upgrades itself to `decline_ava`.
  ///
  /// What this used to do — and why it was wrong. It read a local DiskCache
  /// mirror of `receptionist_enabled` and, if set, rewrote the callee's Decline
  /// into `decline_ava`. So the SAME red button meant "end this call" for one
  /// user and "put the caller through to my paid AI receptionist" for another,
  /// with nothing on screen to say which. Worse, the mirror is written by a
  /// Settings card and this method frequently runs in a COLD push-woken isolate
  /// where the mirror may not be populated at all — so the same user got
  /// different behaviour depending on whether their app happened to be warm.
  /// That non-determinism is why decline behaviour kept "randomly" changing.
  ///
  /// Handing the caller to Ava is now an explicit, separate user choice — the
  /// Receptionist action, which signals `decline_ava` via
  /// [receptionistIncomingCall]. See Specs/CALL-OUTCOMES-FROZEN-2026-08-01.md.
  /// [CALL-OBS-1 2026-08-03] `origin` distinguishes a HUMAN decline from a
  /// synthetic one, which is the single most important thing this telemetry
  /// could not say.
  ///
  /// `call_incoming_declined` carried no source field at all, so the phantom
  /// declines that killed five of the last seven accepts were, in the data,
  /// indistinguishable from a user pressing the red button. Attribution had to
  /// be inferred from an adjacent event's `source` and from millisecond
  /// ordering against the accept — which is not a metric anyone can alert on.
  ///
  ///   `user_tap`       — the callee pressed Decline in the branded screen.
  ///   `callkit_native` — the OS notification's Decline action. On affected
  ///                      Motorola builds this ALSO fires for a programmatic
  ///                      `endCall()` on an accepted call, which is the bug.
  ///   `os_timeout`     — nobody answered.
  static Future<void> _declineRouting(Map extra, {required String origin}) async {
    unawaited(_dismissBrandedFsi()); // [AVACALL-INUI-2] clear the lock-screen FSI banner
    final callId = (extra['callId'] ?? '').toString();
    final from = (extra['from'] ?? '').toString();
    // [CALL-REL-9] Covers both the native CallKit decline (which also stops it
    // at the event-listener call site — harmless idempotent double-stop) and
    // the branded in-app screen's decline/block, which reaches this method
    // directly via the public `declineIncomingCall` wrapper and never goes
    // through the CallKit event listener at all.
    unawaited(_stopRingtoneFallback(callId));
    // [PIV-2 2026-08-02] Run the ONE reducer so the branded full-screen ring
    // closes too. This path only ever signalled the decline OUTWARD to the
    // caller and tore down its own subset of surfaces; the callee's device
    // never gets a `call-status` push back for its OWN decline (the server
    // broadcasts that to the caller), so nothing else was ever going to close
    // the branded screen. Symptom: caller correctly saw "call declined" while
    // the callee's ring screen stayed up forever — reported 2026-08-02 for a
    // decline taken on the CallKit notification, where the branded screen
    // underneath is a SEPARATE surface from the notification's own buttons.
    // Idempotent, so the in-app screen calling this after its own
    // `applyRingTransition` is a no-op.
    unawaited(applyRingTransition(callId, 'decline', source: 'decline_routing'));
    _signalStatus(callId, 'decline', from);
    // CALL-GLARE-1: dedupe duplicate decline events for the same call.
    if (_onceCallEvent(callId, 'declined')) {
      Analytics.capture('call_incoming_declined', {
        'call_id': callId,
        'routed_to': 'decline',
        // [CALL-OBS-1] WHO ended the ring — see _declineRouting's doc comment.
        'origin': origin,
        // [PIV-2 2026-08-02] The CALLER's uid. `Analytics` auto-stamps the
        // decliner's own email, so without the peer here a decline was only
        // ever retrievable from one side — and a call bug is a conversation
        // between two devices. Tagging both makes either tester's email pull
        // the same interaction.
        'peer_uid': from,
      });
    }
    _logMissed(extra, origin: origin);
  }

  /// [CALL-QUICK-REPLY-1 2026-08-01] "Message" on the incoming-call screen: end
  /// the call on BOTH ends and send the caller a canned reply.
  ///
  /// Ordering is deliberate and load-bearing. The call is terminated FIRST
  /// (`_signalStatus`), then the message is enqueued. Coupling them the other
  /// way round — or transactionally — would mean a momentarily unavailable
  /// messenger leaves the caller ringing at a callee who has already dismissed
  /// the screen. The call ending is the user's primary intent; the text is a
  /// courtesy that can retry.
  ///
  /// `quickReplyId` + `catalogVersion` are the authoritative content reference.
  /// `fallbackText` is sent only so a server that does not yet know this catalog
  /// version can still deliver something readable; the server must prefer its
  /// own catalog entry whenever it recognises the id.
  static Future<void> quickReplyIncomingCall(
    Map extra, {
    required String quickReplyId,
    required int catalogVersion,
    required String fallbackText,
  }) async {
    unawaited(_dismissBrandedFsi());
    final callId = (extra['callId'] ?? '').toString();
    final from = (extra['from'] ?? '').toString();
    unawaited(_stopRingtoneFallback(callId));
    // Terminal for the caller — Message ends the call, it does not park it.
    // [CALL-CMD-IDEMPOTENT-2] Distinct intent: a quick reply and a plain
    // decline both ride the `decline` status and must not collapse together.
    final declined = await _signalStatus(callId, 'decline', from, intent: 'quick_reply');
    if (_onceCallEvent(callId, 'declined')) {
      Analytics.capture('call_incoming_declined', {
        'call_id': callId,
        'routed_to': 'quick_reply',
        'origin': 'user_tap',
        'quick_reply_id': quickReplyId,
      });
    }
    _logMissed(extra, origin: 'quick_reply');
    if (!declined || from.isEmpty) return;
    try {
      final res = await ApiAuth.postJson(kCallQuickReplyUrl, {
        'to': from,
        'callId': callId,
        'quickReplyId': quickReplyId,
        'catalogVersion': catalogVersion,
        'fallbackText': fallbackText,
      });
      Analytics.capture('call_quick_reply_sent', {
        'call_id': callId, 'to_uid': from, 'quick_reply_id': quickReplyId,
        'http_status': res.statusCode, 'ok': res.statusCode == 200,
      });
    } catch (e) {
      Analytics.capture('call_quick_reply_failed', {
        'call_id': callId, 'to_uid': from, 'quick_reply_id': quickReplyId,
        'error': e.toString(),
      });
    }
  }

  /// [CALL-VOICEMAIL-1 2026-08-01] "Voice Mail" on the incoming-call screen:
  /// stop MY ring and offer the CALLER a recorder so they can leave a message.
  ///
  /// Signals `decline_vm`, which is a HANDOFF, not a terminal status — the
  /// caller's session must stay alive to record. The caller's CallSession parks
  /// in the outcome-menu phase, whose recorder already uploads to R2 and
  /// delivers a normal audio message into this thread. Nothing about the
  /// voicemail is a separate silo: it is an ordinary messenger message, so it
  /// inherits unread counts, delivery, ordering, retention and deletion.
  static Future<void> voicemailIncomingCall(Map extra) async {
    unawaited(_dismissBrandedFsi());
    final callId = (extra['callId'] ?? '').toString();
    final from = (extra['from'] ?? '').toString();
    unawaited(_stopRingtoneFallback(callId));
    _signalStatus(callId, 'decline_vm', from);
    if (_onceCallEvent(callId, 'declined')) {
      Analytics.capture('call_incoming_declined', {
        'call_id': callId,
        'routed_to': 'decline_vm',
        'origin': 'user_tap',
      });
    }
    _logMissed(extra, origin: 'sent_to_voicemail');
  }

  /// [CALL-SPAM-REPORT-1 2026-08-01] "Report Spam" on the incoming-call screen.
  ///
  /// Reporting and blocking are DELIBERATELY separate — a user may want to flag
  /// a suspicious caller while still allowing future calls through to
  /// screening, and silently blocking on report would be a surprise the UI
  /// never promised. `alsoBlock` is passed only when the user asked for it.
  ///
  /// The call is terminated first; the report is filed after. A reporting
  /// outage must never leave the phone ringing.
  static Future<void> reportSpamIncomingCall(
    Map extra, {
    required bool alsoBlock,
    String category = 'spam',
    int? ringDurationMs,
  }) async {
    unawaited(_dismissBrandedFsi());
    final callId = (extra['callId'] ?? '').toString();
    final from = (extra['from'] ?? '').toString();
    unawaited(_stopRingtoneFallback(callId));
    // [CALL-CMD-IDEMPOTENT-2] `intent` distinguishes this from a plain decline.
    // Both go out as status `decline`, so without it the server would treat a
    // report that followed a decline on the same call as a duplicate and
    // silently drop it.
    _signalStatus(callId, 'decline', from,
        intent: alsoBlock ? 'report_spam_block' : 'report_spam');
    if (_onceCallEvent(callId, 'declined')) {
      Analytics.capture('call_incoming_declined', {
        'call_id': callId,
        'routed_to': alsoBlock ? 'spam_and_block' : 'spam',
        'origin': 'user_tap',
      });
    }
    _logMissed(extra, origin: 'reported_spam');
    if (from.isEmpty) return;
    try {
      final res = await ApiAuth.postJson(kCallReportUrl, {
        'reportedUid': from,
        'callId': callId,
        'category': category,
        'alsoBlock': alsoBlock,
        if (ringDurationMs != null) 'ringDurationMs': ringDurationMs,
      });
      Analytics.capture('call_spam_report_sent', {
        'call_id': callId, 'reported_uid': from, 'also_block': alsoBlock,
        'http_status': res.statusCode, 'ok': res.statusCode == 200,
      });
    } catch (e) {
      Analytics.capture('call_spam_report_failed', {
        'call_id': callId, 'reported_uid': from, 'error': e.toString(),
      });
    }
  }

  /// [CALL-DECLINE-IS-TERMINAL-1 2026-08-01] "Receptionist" on the incoming-call
  /// screen — the callee's ring stops and the CALLER is handed to Ava to leave a
  /// message. This is the ONLY path that may produce `decline_ava`.
  ///
  /// Deliberately a sibling of [declineIncomingCall] rather than a flag on it:
  /// the two are different user intentions with different outcomes for the
  /// caller (one drops them, one keeps their leg alive), and collapsing them
  /// into one function with a boolean is what created the ambiguity above.
  static Future<bool> receptionistIncomingCall(Map extra) async {
    unawaited(_dismissBrandedFsi());
    final callId = (extra['callId'] ?? '').toString();
    final from = (extra['from'] ?? '').toString();
    unawaited(_stopRingtoneFallback(callId));
    final handedOff = await _signalStatus(callId, 'decline_ava', from);
    // Same dedupe key as decline — mutually exclusive outcomes of ONE ring.
    if (_onceCallEvent(callId, 'declined')) {
      Analytics.capture('call_incoming_declined', {
        'call_id': callId,
        'routed_to': 'decline_ava',
        'origin': 'user_tap',
      });
    }
    _logMissed(extra, origin: 'sent_to_receptionist');
    return handedOff;
  }

  /// [CALL-OBS-1 2026-08-03] `origin` says WHAT ENDED THE RING, and it decides
  /// whether this was a missed call at all.
  ///
  /// Every terminal path called this, so `call_incoming_declined` and
  /// `call_incoming_missed` were emitted together, in the same millisecond, on
  /// every outcome — an explicit decline, a quick reply, a spam report, and a
  /// perfectly successful receptionist handoff all counted as MISSED. Lifetime
  /// counts were 65 and 66. The metric could not answer the one question it
  /// exists to answer ("how often does nobody pick up?"), and a handoff to Ava
  /// — a call that was ANSWERED, by Ava — was indistinguishable from a call
  /// that rang out.
  ///
  /// A missed call is a ring that ended with no decision from the callee. An
  /// explicit choice is not a miss, whatever the choice was.
  ///
  /// The LOCAL CALL LOG entry is deliberately unchanged and still written on
  /// every path: showing a declined call in the recents list is a long-standing
  /// product behaviour that users expect from every phone, and it is not what
  /// this fix is about.
  static void _logMissed(Map extra, {required String origin}) {
    final missedId = (extra['callId'] ?? '').toString();
    const noDecisionByCallee = {'os_timeout', 'unreachable', 'caller_cancelled'};
    // CALL-GLARE-1: dedupe duplicate missed events for the same call (CallKit
    // can fire timeout more than once).
    if (noDecisionByCallee.contains(origin) && _onceCallEvent(missedId, 'missed')) {
      Analytics.capture('call_incoming_missed', {
        'call_id': missedId,
        'kind': extra['kind'] == 'video' ? 'video' : 'audio',
        'origin': origin,
      });
    }
    CallLogStore().add(CallEntry(
      name: (extra['fromName'] ?? 'Caller').toString(),
      seed: (extra['from'] ?? 'caller').toString(),
      video: extra['kind'] == 'video',
      dir: CallDir.missed,
      ts: DateTime.now().millisecondsSinceEpoch ~/ 1000,
      // [CALL-LOG-TIME-1] Terminal on arrival — there is no later "finish" for a
      // call that was never answered, so stamp the outcome now.
      outcome: CallOutcome.missed,
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

  /// [AVACALL-CANCEL-1/CALL-HANDOFF-CALLEE-CLOSE-1] Best-effort durable ring
  /// status. For a callee, a server-owned Ava/voicemail handoff is ring-terminal
  /// even though the caller's service leg remains live. The authenticated API
  /// exposes that distinction as a callee-only status. FAIL-OPEN: a network
  /// failure never blocks a legitimate answer.
  static Future<String?> fetchDurableCallStatus(
    String callId, {
    Duration timeout = const Duration(seconds: 4),
  }) async {
    if (callId.isEmpty) return null;
    try {
      final res = await ApiAuth.getSigned(
        '$kCallStateUrl?callId=${Uri.encodeQueryComponent(callId)}',
        timeout: timeout,
      );
      if (res.statusCode != 200) return null;
      final j = jsonDecode(res.body);
      if (j is! Map) return null;
      final terminal = (j['terminal_status'] ?? '').toString();
      if (terminal.isNotEmpty) {
        _noteTerminalCall(callId); // fold into the cache for any later checker
        // The DO persists its internal disposition (for example
        // `caller_cancelled`), while the client reducer intentionally accepts
        // only the small legacy wire vocabulary. Any non-empty durable marker
        // is authoritative terminal truth; normalize unknown internal names
        // to the generic wire status so an offline/missed FCM cannot leave the
        // incoming screen ringing forever.
        return _terminalCallStatus(terminal) ? terminal : 'ended';
      }
      final ringStatus = (j['ring_status'] ?? '').toString();
      if (ringStatus == 'decline_ava' || ringStatus == 'decline_vm' ||
          ringStatus == 'decline_agent') {
        return ringStatus;
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
  /// [ONERING-1 2026-08-02] `fallbackExtra` lets a caller answer a ring that was
  /// never registered with CallKit.
  ///
  /// This method used to be able to answer ONLY a call it could find in
  /// `FlutterCallkitIncoming.activeCalls()` — it reads the call's `extra`
  /// payload back out of the OS. That is a hard dependency on the native ring
  /// existing, and it is why the OS banner could not simply be suppressed: with
  /// no CallKit entry the loop below matches nothing, this method returns having
  /// done nothing at all, and the branded screen's Accept button is a dead
  /// button with no error anywhere.
  ///
  /// The branded screen already knows everything the payload contains (it was
  /// built from the same push), so it can now hand its own copy in. CallKit
  /// stays the source of truth whenever it HAS the call — `fallbackExtra` is
  /// consulted only when the lookup finds nothing, so every existing path
  /// behaves exactly as before.
  static Future<void> acceptRingingCall(String callId, {Map? fallbackExtra}) async {
    unawaited(_dismissBrandedFsi()); // [AVACALL-INUI-2] clear the lock-screen FSI banner
    // [AVACALL-CANCEL-1] Don't answer into a call the caller already cancelled.
    if (wasCallTerminated(callId)) {
      Analytics.capture('call_accepted_dead', {
        'call_id': callId,
        'via': 'accept_ringing_cache',
      });
      unawaited(_finishAcceptedRing(callId));
      return;
    }

    dynamic openExtra = fallbackExtra;
    // Capture the native payload only when the caller did not already supply
    // the push payload. The branded screen always supplies it, so its Accept
    // path can tear down the Android ring immediately instead of waiting up to
    // 900 ms for an activeCalls lookup that cannot add any useful information.
    if (openExtra == null) {
      dynamic calls;
      try {
        calls = await FlutterCallkitIncoming.activeCalls()
            .timeout(const Duration(milliseconds: 900));
      } on TimeoutException {
        Analytics.capture('call_accept_native_lookup_timeout', {
          'call_id': callId,
          'timeout_ms': 900,
        });
      } catch (e) {
        Analytics.capture('call_accept_native_lookup_failed', {
          'call_id': callId,
          'error': e.toString(),
        });
      }
      if (calls is List) {
        for (final c in calls) {
          if (c is Map && (c['id'] ?? '').toString() == callId) {
            openExtra = c['extra'];
            break;
          }
        }
      }
    }

    // Accept is user intent: publish the device-level lease before removing
    // every ring surface. The awaited write closes the foreground/background
    // isolate gap that caused the ghost ring in production.
    await _markIncomingCallAcceptedDurably(callId);

    // Accept is user intent: remove every ring surface NOW, before the network
    // authority round-trip. flutter_callkit_incoming implements endCall() for
    // an unaccepted ring by broadcasting ACTION_CALL_DECLINE; the build-locked
    // native hook stamps that action as programmatic before it is broadcast,
    // while _finishAcceptedRing provides the same guard to the live Dart VM.
    // This ordering both closes the old 0-2700 ms false-decline window and stops
    // the Android heads-up ring from lingering after the user taps Accept.
    unawaited(_finishAcceptedRing(callId));

    if (openExtra == null) {
      Analytics.capture('call_accept_payload_missing', {'call_id': callId});
      return;
    }

    Analytics.capture('call_accept_open_scheduled', {
      'call_id': callId,
      'payload_source':
          identical(openExtra, fallbackExtra) ? 'push_fallback' : 'callkit',
    });
    // [CALL-ACCEPT-FLASH-1] Open CallScreen BEFORE the network claim, not
    // after it. The claim (`_claimHumanAccept`) races a POST against the
    // server-owned receptionist alarm and can take up to ~2.7s worst case
    // (1500ms POST timeout + 1200ms durable-status fallback fetch) — this used
    // to be AWAITED here, so the branded ring screen sat on "Connecting…" for
    // that whole window while its own 2500ms hold timeout raced it. When the
    // hold timeout won, the ring route was removed before CallScreen ever
    // existed: dead air, then a delayed CallScreen "re-appearance" (PostHog
    // avatok call 2026-08-04: accept tap 18:07:19.57, screen_opened
    // 18:07:21.56, dismissed 1ms later, call_connected only at 18:07:23.9).
    //
    // CallScreen is now pushed FIRST — one continuous forward transition, no
    // gap — and the claim runs CONCURRENTLY in `_trackClaimAfterOpen`. If the
    // claim later reports we lost the race (call already gone/taken), the
    // existing applyRingTransition -> `_noteTerminalCall` marker plus
    // CallSession's own pre-accept-cancel checks (`wasCallTerminated`,
    // `_checkDurablePreAcceptCancel`) tear the just-opened CallScreen down
    // honestly instead of leaving it live on a call nobody won.
    await _openCall(openExtra, claimPending: true);
    unawaited(_trackClaimAfterOpen(callId));
  }

  /// [CALL-ACCEPT-FLASH-1] Runs the human-accept claim CONCURRENTLY with
  /// CallScreen already being on screen (see [acceptRingingCall]). Emits
  /// `call_accept_claim_after_open` either way so a regression here is
  /// measurable, and on an authoritative loss feeds the same reducer the old
  /// blocking preflight used so CallScreen tears itself down honestly.
  static Future<void> _trackClaimAfterOpen(String callId) async {
    final t0 = DateTime.now().millisecondsSinceEpoch;
    String? authoritative;
    try {
      authoritative = await _claimHumanAccept(callId);
    } catch (e, st) {
      Analytics.captureException(
        e,
        st,
        handled: true,
        screen: 'push_service',
        extra: {'stage': 'claim_after_open', 'call_id': callId},
      );
    }
    Analytics.capture('call_accept_claim_after_open', {
      'call_id': callId,
      'ok': authoritative == null,
      'ms': DateTime.now().millisecondsSinceEpoch - t0,
    });
    if (authoritative != null) {
      unawaited(applyRingTransition(
        callId,
        authoritative,
        source: 'accept_claim_after_open',
      ));
      Analytics.capture('call_late_accept_blocked', {
        'call_id': callId,
        'status': authoritative,
      });
    }
  }

  /// [CALL-ACCEPT-FLASH-1] Test-only override — mirrors the
  /// `MoneyApi.debugGetOverride` seam already used in this codebase (see
  /// `wallet_entitlement_test.dart`) so the accept flow's ORDERING contract
  /// (CallScreen is requested before this claim resolves, not after) is
  /// testable deterministically, with a controllable/delayable result, and
  /// without a live network or the CallKit/webrtc plugin surface.
  @visibleForTesting
  static Future<String?> Function(String room)? debugClaimHumanAcceptOverride;

  /// [CALL-ACCEPT-FLASH-1] Test-only hook fired the instant `_openCall`
  /// reaches the point of requesting CallScreen (right before it reads
  /// `navigatorKey.currentState`) — the moment this fix's contract cares
  /// about, independent of whether a real Navigator is mounted.
  @visibleForTesting
  static void Function(String callId)? debugOnCallScreenOpenAttempt;

  /// Atomically race a human Accept against the server-owned four-ring alarm.
  /// Returns a terminal status when another outcome already won; null means
  /// the human leg is claimed (or the network failed open and WebSocket
  /// admission remains the final authority).
  static Future<String?> _claimHumanAccept(String room) async {
    final override = debugClaimHumanAcceptOverride;
    if (override != null) return override(room);
    String? authoritative;
    try {
      final claim = await ApiAuth.postJson(
        kCallCommandUrl,
        {
          'callId': room,
          'command': 'accept_call',
          'commandId': 'accept:$room',
        },
        timeout: const Duration(milliseconds: 1500),
      );
      if (claim.statusCode < 200 || claim.statusCode >= 300) {
        authoritative = await fetchDurableCallStatus(
          room,
          timeout: const Duration(milliseconds: 1200),
        );
        if (authoritative == null && claim.statusCode == 409) {
          authoritative = 'ended';
        }
      } else {
        // A successful command response can still race a caller cancellation
        // already committed by the time the native Accept event reaches us.
        // Re-read the DO immediately so this stale accept cannot tear down a
        // live call in prepareForAccept().
        authoritative = await fetchDurableCallStatus(
          room,
          timeout: const Duration(milliseconds: 1200),
        );
      }
    } catch (_) {
      authoritative = await fetchDurableCallStatus(
        room,
        timeout: const Duration(milliseconds: 1200),
      );
    }
    return authoritative;
  }

  static Future<void> _openCall(
    dynamic extra, {
    bool acceptAlreadyClaimed = false,
    // [CALL-ACCEPT-FLASH-1] True when the caller (acceptRingingCall) is
    // running `_claimHumanAccept` CONCURRENTLY with this open rather than
    // having already resolved it. Treated like `acceptAlreadyClaimed` here —
    // this method must not ALSO block on its own claim, or opening CallScreen
    // would wait on the very network round-trip this param exists to skip.
    // The concurrent claim's own failure path (applyRingTransition) tears the
    // screen down after the fact if it turns out to have lost the race.
    bool claimPending = false,
  }) async {
    try {
      final e = (extra as Map);
      final room = (e['callId'] ?? '').toString();
      if (room.isEmpty) return;
      // [CALL-REL-R4-3] Cold-start credential recovery. Every accept route —
      // native CallKit, branded screen, lock-screen tap — funnels through here,
      // and `extra` is the one carrier that provably survived process death. If
      // the background isolate's write did not finish (or ran under a different
      // account scope), this is where the token comes back. `_depositRoomToken`
      // is first-non-empty-wins, so re-depositing an already-known token is a
      // no-op and this can never overwrite a good value with a stale one.
      final recoveredRoomToken = (e['roomToken'] ?? '').toString();
      if (recoveredRoomToken.isNotEmpty && roomTokenFor(room).isEmpty) {
        await rememberCallRoomTokenDurable(room, recoveredRoomToken);
        Analytics.capture('call_room_token_recovered', {
          'call_id': room,
          'source': 'callkit_extra',
        });
      }
      // [GCALL-W4-RING] Accepting a GROUP ring joins the conference instead of
      // opening a 1:1 CallScreen. It also skips the CallRoom accept-claim below:
      // that claim exists to make exactly one leg win the race against the Ava
      // receptionist alarm on a two-party call, and a group call has neither a
      // CallRoom record nor a receptionist. The GroupCallRoom authority is what
      // admits a joiner, and it admits everyone up to the cap.
      if (e['group'] == true || e['group'] == 'true') {
        await _openGroupCall(e);
        return;
      }
      // The cancellation push and branded-screen durable poll are fast paths,
      // but Accept is the dangerous boundary. Atomically claim the human leg in
      // CallRoom before opening CallScreen. This command races the four-ring Ava
      // alarm inside one Durable Object: exactly one can win.
      final authoritative = (acceptAlreadyClaimed || claimPending)
          ? null
          : await _claimHumanAccept(room);
      if (authoritative != null) {
        await applyRingTransition(
          room,
          authoritative,
          source: 'accept_authority_preflight',
        );
        Analytics.capture('call_late_accept_blocked', {
          'call_id': room,
          'status': authoritative,
        });
        return;
      }
      // [CALL-REL-9] Single choke point every accept path funnels through
      // (native CallKit `actionCallAccept`, the branded in-app screen via
      // `acceptRingingCall`, and CALLFIX-14 glare auto-accept) — stop the
      // in-app fallback ringtone here so it can never survive into a
      // connected call. Idempotent/no-op if it was already stopped or never
      // started.
      unawaited(_stopRingtoneFallback(room));
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
      //
      // [CALL-ACCEPT-GAP-1 2026-08-03] Now conditional. This is only meaningful
      // when another session actually owns audio, which on a normal accept it
      // does not — yet every accept paid for it behind a 5-second timeout, in
      // front of the UI, contributing to the blank gap. When there IS another
      // audio owner we still block: handing the mic to a second session while
      // Ava is mid-sentence is the 2026-07-05 bug and is worth the wait.
      if (CallSessionManager.instance.hasOtherLiveAudioSession(room)) {
        // [CALL-ACCEPT-LIVENESS-1 2026-08-06] Do not kill a WORKING call to
        // answer a DEAD one.
        //
        // Prod, 2026-08-05 21:51:28. The owner was on a live call and a fourth
        // ring from the same person arrived. He tapped Accept. In this order:
        //
        //   21:51:28.183  call_ended_for_accept  owner-accepted-other-call
        //   21:51:29.531  call_accepted_dead     remote-cancelled-preaccept
        //   21:51:30.693  call_late_accept_blocked
        //
        // The live call was torn down 1.3 SECONDS BEFORE the app discovered the
        // call it switched to had already been cancelled. He lost a working
        // call and got nothing in return.
        //
        // The teardown is irreversible and the check is cheap, so the check goes
        // first. Two sources, both already used elsewhere on this path:
        //
        //  1. `wasCallTerminated` — a local marker, free, no network.
        //  2. `fetchDurableCallStatus` — a strongly-consistent read of the
        //     CallRoom DO, which is the authority on terminal status.
        //
        // Deliberately FAIL-OPEN and tightly bounded (1200ms): if the probe is
        // slow or errors we proceed with the accept exactly as before. Refusing
        // an accept because a probe timed out would turn a rare bad outcome into
        // a common one. This only ever fires on the branch where another call is
        // already live, so it costs a normal accept nothing.
        var incomingIsDead = wasCallTerminated(room);
        if (!incomingIsDead) {
          final status = await fetchDurableCallStatus(
            room,
            timeout: const Duration(milliseconds: 1200),
          );
          // RING lifecycle, not CALL lifecycle — the question here is exactly
          // "has this ring stopped being answerable", which is what
          // `_terminalCallStatus` decides.
          incomingIsDead = status != null && _terminalCallStatus(status);
        }
        if (incomingIsDead) {
          Analytics.capture('call_accept_refused_dead_incoming', {
            'call_id': room,
            'kept_live_call': true,
          });
          // Fold it into the terminal cache so no other lane (a late FCM, a
          // retried WS ring) re-surfaces the same dead call.
          _noteTerminalCall(room);
          // Safe to just stop: `_finishAcceptedRing` already removed every ring
          // surface further up `acceptRingingCall`, BEFORE `_openCall` was ever
          // invoked. The user sees their existing call, uninterrupted, which is
          // the whole point.
          return;
        }
        try {
          await CallSessionManager.instance
              .prepareForAccept(room)
              .timeout(const Duration(seconds: 5));
        } on TimeoutException {
          Analytics.capture('call_accept_prior_session_timeout', {
            'call_id': room,
            'timeout_ms': 5000,
          });
        } catch (e) {
          Analytics.capture('call_accept_prior_session_failed', {
            'call_id': room,
            'error': e.toString(),
          });
        }
      }
      // [CALL-ACCEPT-FLASH-1] This is the moment CallScreen is genuinely being
      // requested — everything above is guards/dedup, everything below is the
      // actual push. Test-only signal for the accept flow's ordering contract
      // (see `debugOnCallScreenOpenAttempt`'s doc comment).
      debugOnCallScreenOpenAttempt?.call(room);
      final nav = navigatorKey.currentState;
      if (nav == null) {
        Analytics.capture('call_accept_navigator_missing', {'call_id': room});
        return;
      }
      // [CALL-ACCEPT-GAP-1 2026-08-03] The disk-backed duplicate check used to
      // run HERE, before the push, behind an 800 ms timeout that failed open.
      // It is now fired behind the mounted screen (below): the authoritative
      // in-process guard is the SYNCHRONOUS (_openedCallId, _openedAt)
      // reservation at the top of this method — the disk map only adds value
      // across a process death, and paying for it in front of the user bought
      // nothing. Marking it processed still happens, just not on the critical
      // path.
      unawaited(_isCallIdProcessed(room));
      nav.push(MaterialPageRoute(
        builder: (_) => CallScreen(
          room: (e['callId'] ?? '').toString(),
          title: (e['fromName'] ?? 'Caller').toString(),
          seed: (e['from'] ?? 'caller').toString(),
          video: e['kind'] == 'video',
          outgoing: false,
          // [CALL-IDENTITY-SNAPSHOT-1] Without this CallScreen always fell
          // back to an initials tile even when the caller's real photo was
          // right there in the ring payload — a jarring identity swap the
          // instant the branded ring screen (which DOES paint the avatar)
          // hands off to CallScreen.
          avatarUrl: callerAvatarFromPayload(Map<String, dynamic>.from(e)),
          traceId: (e['trace_id'] ?? '').toString(), // [TRACE-ID-1]
        ),
      ));
      Analytics.capture('call_accept_screen_opened', {'call_id': room});
    } catch (e, st) {
      Analytics.captureException(
        e,
        st,
        handled: true,
        screen: 'push_service',
        extra: {'stage': 'open_accepted_call'},
      );
    }
  }

  /// [GCALL-W4-RING] The group call this phone is ringing for has ended. Stop
  /// the ring and record it as a missed group call.
  ///
  /// Goes through `_programmaticCallkitEnd` like every other programmatic end:
  /// some Android OEMs emit `actionCallDecline` synchronously from `endCall()`,
  /// and without the marker that synthetic event is indistinguishable from the
  /// user having tapped Decline.
  static void cancelGroupRing(String callId, {String gid = ''}) {
    if (callId.isEmpty) return;
    if (!_onceCallEvent(callId, 'group_ring_cancelled')) return;
    _programmaticCallkitEnd.mark(callId);
    unawaited(_stopRingtoneFallback(callId));
    unawaited(FlutterCallkitIncoming.endCall(callId).catchError((_) {/* already gone */}));
    unawaited(CallLogStore().add(CallEntry(
      name: _groupRingNames.remove(callId) ?? 'Group call',
      seed: gid.isEmpty ? 'group' : gid,
      video: false,
      dir: CallDir.missed,
      ts: DateTime.now().millisecondsSinceEpoch ~/ 1000,
      outcome: CallOutcome.missed, // [CALL-LOG-TIME-1]
    )).catchError((_) {/* log is best-effort */}));
    Analytics.capture('group_call_ring_cancelled',
        {'call_id': callId, 'gid_hash': gid.hashCode.toString()});
  }

  /// callId → group name, remembered at ring time so a cancel (which carries no
  /// title) can still write a recognisable call-log row.
  static final Map<String, String> _groupRingNames = <String, String>{};

  static void rememberGroupRingName(String callId, String name) {
    if (callId.isEmpty || name.isEmpty) return;
    if (_groupRingNames.length > 32) _groupRingNames.clear(); // bounded
    _groupRingNames[callId] = name;
  }

  /// [GCALL-W4-RING] Accepting a group ring: dismiss the ring UI, then open the
  /// conference. Joining is idempotent server-side (the authority admits anyone
  /// up to the cap), so unlike the 1:1 path there is no leg to claim first.
  static Future<void> _openGroupCall(Map e) async {
    final gid = (e['gid'] ?? '').toString();
    final callId = (e['callId'] ?? '').toString();
    if (gid.isEmpty) return;
    try { await FlutterCallkitIncoming.endAllCalls(); } catch (_) {/* ring already gone */}
    if (CloudflareConferenceController.activeGid != null) {
      Analytics.capture('group_call_accept_ignored',
          {'call_id': callId, 'reason': 'already_in_call'});
      return;
    }
    final nav = navigatorKey.currentState;
    if (nav == null) {
      Analytics.capture('group_call_accept_no_navigator', {'call_id': callId});
      return;
    }
    final title = (e['groupName'] ?? '').toString();
    nav.push(MaterialPageRoute(
      builder: (_) => CloudflareConferenceScreen(
        gid: gid,
        title: title.isEmpty ? 'Group call' : title,
        video: e['kind'] == 'video',
        // Whoever accepts a ring is joining a call that already exists — never
        // the starter. Getting this wrong would post a second "call started"
        // message to the group.
        starter: false,
      ),
    ));
    Analytics.capture('group_call_accept_screen_opened', {
      'call_id': callId,
      'gid_hash': gid.hashCode.toString(),
      'group_name': title,
      'from_uid': (e['from'] ?? '').toString(),
      'from_name': (e['fromName'] ?? '').toString(),
      'kind': (e['kind'] ?? 'audio').toString(),
    });
  }
}
