import 'dart:async';
import 'dart:convert';
import 'dart:io' show InternetAddress;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/io.dart';

import '../core/analytics.dart';
import '../core/api_auth.dart';
import '../core/ava_log.dart';
import '../core/call_log_store.dart';
import '../core/chat_state.dart' show ReadStateStore, HiddenStore, DeletedStore;
import '../core/config.dart';
import '../core/db.dart';
import '../core/disk_cache.dart';
import '../core/message_store.dart' show SafetyFlagStore;
import '../identity/identity.dart';
import 'dm.dart' show DmMessage;
import 'legacy_stubs.dart';


/// A delivered message, server-routed plaintext (Cloudflare-native; Nostr gone).
/// Consumers (chat list, threads, group threads) filter by [convKey].
class HubEvent {
  final String convKey; // '1:<peerUid>' (DM) or 'g:<convId>' (group)
  final String senderPub;
  final String recipientPub;
  final bool mine;
  final String rumorId;
  final String payload;
  final int createdAt;
  HubEvent(this.convKey, this.senderPub, this.recipientPub, this.mine,
      this.rumorId, this.payload, this.createdAt);
  DmMessage toDm() => DmMessage(rumorId: rumorId, mine: mine, payload: payload, createdAt: createdAt);
}

/// App-lifetime singleton holding the ONE WebSocket to my per-user InboxDO and an
/// in-memory store of every message seen this session. The server already routes
/// + stores plaintext, so there is no per-message crypto: we connect, send a
/// cursor, receive the backlog + live messages, persist them to local SQLite, and
/// fan a [HubEvent] to every screen. The chat list paints instantly from the local
/// projection; this stream carries new + live messages on top.
class SyncHub {
  static final SyncHub I = SyncHub._();
  SyncHub._();

  final NostrClient _stub = NostrClient(kInboxWsUrl); // returned to callers (compat)
  bool _started = false;

  WebSocketChannel? _ch;
  StreamSubscription? _sub;
  Timer? _pingTimer;
  Timer? _reconnectTimer;
  bool _wantConnected = false;
  bool _connecting = false;
  int _retry = 0;
  // ms of the last frame received from the server (incl. pong). Drives the
  // zombie-socket watchdog: on a mobile network switch a WebSocket can go
  // half-open (TCP dead, no close event), silently stalling live delivery — the
  // "his message took 5 min to arrive even after I reopened the app" bug. If we
  // hear nothing for a while we assume the socket is dead and reconnect.
  int _lastRecvAt = 0;
  int _cursor = 0; // highest InboxDO message id ingested (persisted per account)
  static const String _kCursorKey = 'ava_inbox_cursor';
  String? _cursorUid;       // account the in-memory _cursor was loaded for
  Timer? _cursorPersistTimer;
  // Transport observability — so PostHog shows, PER DEVICE, whether the realtime
  // socket is actually up and receiving frames (this is how we tell a "connected
  // Mac that isn't getting live deletes" from a phone that is). Per-account
  // platform/email already ride every event via Analytics._base.
  int _reconnects = 0;            // cumulative reconnect attempts this session
  int _connectedAt = 0;          // ms epoch of the current connection (0 = down)
  // P13-A latency instrumentation.
  int _openStartedAt = 0;        // _open() start → hub_connected connect_ms
  int _syncStartedAt = 0;        // last 'hello' send → sync_catchup ms
  String _syncTrigger = 'login'; // login|resume|reconnect|zombie|push — labels the next sync
  int _foregroundAt = 0;         // last foreground/login instant → ttfm_ms base
  bool _ttfmEmitted = true;      // reset false on foreground; true after first msg render
  final Map<String, int> _frameCounts = {}; // frames received this connection, by type

  final Map<String, List<DmMessage>> _byConv = {};
  final Set<String> _seen = {}; // dedup by client_id (or server id)
  bool _dbLogged = false;

  final _incoming = StreamController<HubEvent>.broadcast();
  Stream<HubEvent> get incoming => _incoming.stream;

  /// Live AvaStorage summaries pushed by the server after any upload/delete in
  /// ANY app (frame {type:'storage', used_bytes, quota_bytes, state, by_category}).
  final _storage = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get storage => _storage.stream;

  /// Live `@ava` token stream (frame {type:'ava_stream', conv, stream_id, phase,
  /// delta}). Transient — never persisted; the open chat thread grows an Ava
  /// bubble as deltas arrive, then the durable answer replaces it. Each emitted
  /// map carries a derived `convKey` so a thread can filter to its own conv.
  final _avaStream = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get avaStream => _avaStream.stream;

  /// F6: live guardian `safety_flag` frames pushed by the server to the RECIPIENT
  /// ({type:'safety_flag', conv, msg_id, category}). Persisted per-account to
  /// [SafetyFlagStore] on receipt, then fanned out so an open thread paints THAT
  /// bubble red without parsing the private-warning message. The SENDER never
  /// receives this frame. Transient stream (the durable state is the store).
  final _safetyFlags = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get safetyFlags => _safetyFlags.stream;

  String? get _myUid => AccountScope.id;

  /// Start (idempotent) the shared InboxDO socket. The priv/pub args are legacy
  /// and ignored — identity is the Clerk uid (AccountScope.id).
  NostrClient ensure(String _myPriv, String _myPub) {
    if (!_started && (_myUid?.isNotEmpty ?? false)) {
      _started = true;
      _wantConnected = true;
      unawaited(drainPendingDeletes()); // apply deletes queued while backgrounded
      unawaited(drainPendingHides());   // apply hide/undo queued while backgrounded
      unawaited(drainPendingCallOps()); // apply call-log deletes/clears queued while asleep
      _open(); // the single realtime backbone; PartyKit rides on top for the ephemeral layer.
      AvaLog.I.log('hub', 'sync started for uid=$_myUid');
    } else {
      ensureConnected();
    }
    return _stub;
  }

  /// [MULTIACCT-3] Fully stop the per-account hub for an account switch/logout.
  /// Sets `_wantConnected=false` FIRST so the socket close does NOT schedule a
  /// reconnect, tears down the socket + timers, and clears the in-memory
  /// per-account caches (thread buffers, dedup set, cursor) so the NEXT account's
  /// `ensure()` starts clean instead of inheriting the previous account's state.
  /// The persisted per-account cursor on disk is left intact (keyed per account),
  /// so re-login re-syncs from where that account left off. Idempotent.
  void stop() {
    _wantConnected = false;
    _reconnectTimer?.cancel(); _reconnectTimer = null;
    _pingTimer?.cancel(); _pingTimer = null;
    _cursorPersistTimer?.cancel(); _cursorPersistTimer = null;
    _sub?.cancel(); _sub = null;
    try { _ch?.sink.close(); } catch (_) {}
    _ch = null;
    _started = false;
    _connecting = false;
    _connectedAt = 0;
    _retry = 0;
    // Drop the previous account's in-memory state so nothing leaks across scopes.
    _byConv.clear();
    _seen.clear();
    _cursor = 0;
    _cursorUid = null;
    AvaLog.I.log('hub', 'sync stopped (account switch/logout)');
  }

  void ensureConnected() {
    if (!_wantConnected) return;
    // P13-A: first cold connect of a session is a ttfm baseline too (login case).
    if (_foregroundAt == 0) { _foregroundAt = DateTime.now().millisecondsSinceEpoch; _ttfmEmitted = false; }
    unawaited(drainPendingDeletes()); // a foreground wake also flushes queued deletes
    unawaited(drainPendingHides());   // …and queued hide/undo ops
    unawaited(drainPendingCallOps()); // …and queued call-log deletes/clears
    if (_ch != null) return;
    _retry = 0;
    _reconnectTimer?.cancel();
    _open();
  }

  /// App returned to the foreground. Catch up in SECONDS instead of waiting for
  /// the OS to eventually tear down a half-open socket: if the socket is gone,
  /// reconnect now; if it looks up, probe it with a ping and reconnect if no
  /// reply lands within 4s. This is what fixes "I reopened the app and the
  /// message still wasn't there" — [ensureConnected] alone is fooled by a zombie
  /// `_ch` that is non-null but dead.
  /// Force the InboxDO to REPLAY everything since our cursor right now. Used by
  /// flows that are actively WAITING for a specific server-delivered message —
  /// notably a marketplace agent-negotiation result, which (owner decision) has
  /// NO FCM and so relies on the live socket broadcast; if that broadcast lands
  /// while the socket is mid-churn it's missed, and nothing else pulls it until
  /// the next app resume. Re-sending the cursor 'hello' makes the DO reply with a
  /// fresh sync of everything after the cursor. Idempotent: _ingestMsg de-dupes
  /// ids we've already seen, so calling this repeatedly is cheap and safe.
  void forceResync() {
    if (_ch == null) { ensureConnected(); return; } // socket down → reconnect (which sends hello)
    try {
      _syncStartedAt = DateTime.now().millisecondsSinceEpoch; // P13-A
      _send({'type': 'hello', 'cursor': _cursor});
    } catch (_) {
      ensureConnected();
    }
  }

  /// P13-B: a data push proves there's something new — kick a cursor sync even if
  /// the socket looks alive (it may be half-open and lying). Called from the FCM
  /// message handlers. If the socket is up we re-send 'hello' (labelled 'push');
  /// if it's down, [ensureConnected] reconnects (which syncs).
  void syncFromPush() {
    _syncTrigger = 'push';
    if (_ch == null) { ensureConnected(); return; }
    try {
      _syncStartedAt = DateTime.now().millisecondsSinceEpoch;
      _send({'type': 'hello', 'cursor': _cursor});
    } catch (_) { ensureConnected(); }
  }

  /// P13-A: emit time-to-first-message once per foreground, when the first message
  /// frame (live or a non-empty sync) is about to render.
  void _maybeEmitTtfm() {
    if (_ttfmEmitted || _foregroundAt <= 0) return;
    _ttfmEmitted = true;
    Analytics.capture('ttfm_ms', {'ms': DateTime.now().millisecondsSinceEpoch - _foregroundAt});
  }

  void onAppResumed() {
    if (!_wantConnected) return;
    // P13-A: time-to-first-message is measured from every foreground.
    _foregroundAt = DateTime.now().millisecondsSinceEpoch;
    _ttfmEmitted = false;
    if (_ch == null) { _syncTrigger = 'resume'; ensureConnected(); return; }
    final idle = DateTime.now().millisecondsSinceEpoch - _lastRecvAt;
    // P13-B: a socket idle >10s on resume is very likely half-open — don't burn 4s
    // pinging and waiting, reconnect NOW so the cursor sync pulls what we missed.
    if (idle > 10000) {
      AvaLog.I.log('hub', 'resume with ${idle}ms idle socket — reconnecting immediately');
      Analytics.capture('inbox_resume_reconnect', {'idle_ms': idle, 'immediate': true});
      _syncTrigger = 'resume';
      _onClosed('resume_idle');
      return;
    }
    // Freshly-active socket (<10s idle): keep the light ping probe.
    final probedAt = DateTime.now().millisecondsSinceEpoch;
    _send({'type': 'ping'});
    Timer(const Duration(seconds: 4), () {
      if (!_wantConnected || _ch == null) return;
      if (_lastRecvAt < probedAt) {
        AvaLog.I.log('hub', 'no reply 4s after resume — reconnecting socket');
        Analytics.capture('inbox_resume_reconnect', {'immediate': false});
        _syncTrigger = 'resume';
        _onClosed('resume_probe'); // schedules an immediate-ish reconnect + cursor catch-up
      }
    });
  }

  Future<void> _open() async {
    if (_connecting || _ch != null || !_wantConnected) return;
    _connecting = true;
    _openStartedAt = DateTime.now().millisecondsSinceEpoch; // P13-A connect_ms base
    try {
      final token = await ApiAuth.clerkBearer?.call();
      if (token == null || token.isEmpty) {
        AvaLog.I.log('hub', 'no Clerk token yet — retry InboxDO connect in 2s');
        _scheduleReconnect();
        return;
      }
      // Mobile DNS for the host intermittently fails (errno 7) on wifi/LTE
      // transitions — fatal for a WebSocket. Pre-resolve with a few quick retries
      // to absorb the blip instead of dropping into the long reconnect backoff.
      if (!kIsWeb) {
        final host = Uri.parse(kInboxWsUrl).host;
        if (host.isNotEmpty && !await _dnsReady(host)) {
          if (!_wantConnected) return;
          AvaLog.I.log('hub', 'DNS not ready for $host — quick retry');
          _scheduleReconnect();
          return;
        }
      }
      final url = '$kInboxWsUrl?token=${Uri.encodeQueryComponent(token)}';
      try {
        _ch = kIsWeb
            ? WebSocketChannel.connect(Uri.parse(url))
            : IOWebSocketChannel.connect(Uri.parse(url), pingInterval: const Duration(seconds: 25));
      } catch (e) {
        AvaLog.I.log('hub', 'InboxDO connect threw: $e');
        Analytics.capture('hub_connect_failed', {'stage': 'connect_threw', 'err': e.toString()});
        _onClosed('connect_threw');
        return;
      }
      _sub = _ch!.stream.listen(
        _onFrame,
        onError: (e) { AvaLog.I.log('hub', 'InboxDO socket error: $e'); _onClosed('error', e.toString()); },
        onDone: () { AvaLog.I.log('hub', 'InboxDO socket closed'); _onClosed('done'); },
        cancelOnError: true,
      );
      _retry = 0;
      _connectedAt = DateTime.now().millisecondsSinceEpoch;
      _lastRecvAt = _connectedAt; // fresh connection counts as just-heard-from
      _frameCounts.clear();
      Analytics.capture('hub_connected', {
        'cursor': _cursor, 'reconnects': _reconnects,
        // P13-A: how long the socket took to establish (ensureConnected → open),
        // and whether we're on cellular ('net' rides every event automatically).
        'connect_ms': _openStartedAt > 0 ? _connectedAt - _openStartedAt : 0,
        'cellular': Analytics.isCellular,
      });
      // Resume from the PERSISTED cursor (once per account) so we don't
      // re-download the entire backlog on every launch — the server returns
      // only messages with id > cursor. SQLite already holds the rest.
      if (_cursorUid != _myUid) {
        final raw = await DiskCache.read(_kCursorKey);
        _cursor = int.tryParse(raw ?? '') ?? 0;
        _cursorUid = _myUid;
      }
      _syncStartedAt = DateTime.now().millisecondsSinceEpoch; // P13-A sync_catchup base
      _send({'type': 'hello', 'cursor': _cursor}); // request backlog since cursor
      _pingTimer?.cancel();
      _pingTimer = Timer.periodic(const Duration(seconds: 25), (_) {
        // Zombie-socket watchdog: if we've received NOTHING (not even a pong)
        // for ~30s, the socket is half-open — tear it down and reconnect so the
        // 'hello' cursor sync pulls whatever we missed, instead of silently
        // stalling live delivery for minutes (the 5-min-message bug). P13-B:
        // window tightened 60s → 30s (with a 25s ping, that's one missed pong).
        final now = DateTime.now().millisecondsSinceEpoch;
        if (_lastRecvAt > 0 && now - _lastRecvAt > 30000) {
          AvaLog.I.log('hub', 'no frames for ${now - _lastRecvAt}ms — dead socket, reconnecting');
          Analytics.capture('inbox_zombie_reconnect', {'idle_ms': now - _lastRecvAt});
          _syncTrigger = 'zombie';
          _onClosed('zombie');
          return;
        }
        _send({'type': 'ping'});
      });
      AvaLog.I.log('hub', 'InboxDO connected; synced from cursor=$_cursor');
    } finally {
      _connecting = false;
    }
  }

  void _onClosed([String reason = 'closed', String? err]) {
    _sub?.cancel(); _sub = null;
    _pingTimer?.cancel(); _pingTimer = null;
    try { _ch?.sink.close(); } catch (_) {}
    _ch = null;
    // Per-device socket-down signal with this connection's uptime + a rollup of how
    // many live frames it actually received (msg/hide/del/sync/…). A device that
    // shows long uptime but zero hide/del frames is the realtime-not-delivering case.
    if (_connectedAt > 0) {
      final upMs = DateTime.now().millisecondsSinceEpoch - _connectedAt;
      _connectedAt = 0;
      Analytics.capture('hub_disconnected', {
        'reason': reason,
        if (err != null) 'err': err,
        'uptime_ms': upMs,
        'frames_total': _frameCounts.values.fold<int>(0, (a, b) => a + b),
        'frames_msg': _frameCounts['msg'] ?? 0,
        'frames_hide': _frameCounts['hide'] ?? 0,
        'frames_del': _frameCounts['del'] ?? 0,
        'frames_sync': _frameCounts['sync'] ?? 0,
        'frames_receipt': _frameCounts['receipt'] ?? 0,
      });
    }
    if (_wantConnected) _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_reconnectTimer?.isActive ?? false) return;
    // P13-A: label the sync that this reconnect will produce (unless a more
    // specific trigger — zombie/resume/push — was already set for this cycle).
    if (_syncTrigger == 'login') _syncTrigger = 'reconnect';
    _retry++;
    _reconnects++;
    final secs = (1 << (_retry > 5 ? 5 : _retry)).clamp(2, 30);
    Analytics.capture('hub_reconnect', {'attempt': _retry, 'backoff_s': secs, 'total': _reconnects});
    _reconnectTimer = Timer(Duration(seconds: secs), _open);
  }

  void _send(Map<String, dynamic> o) {
    try { _ch?.sink.add(jsonEncode(o)); } catch (_) {}
  }

  // Pending online-search requests, keyed by reqId, completed by the 'searchResults'
  // frame. Used by global message search to fill what the local device is missing.
  final Map<String, Completer<List<Map<String, dynamic>>>> _searchReqs = {};

  /// ONLINE message search across ALL my conversations (server-side, per-user).
  /// Returns [] if the socket is down or it times out (the caller has already
  /// shown instant LOCAL results, so this is a best-effort top-up).
  Future<List<Map<String, dynamic>>> searchOnline(String q) {
    final query = q.trim();
    if (query.length < 2 || _ch == null) return Future.value(const []);
    final reqId = 's${DateTime.now().microsecondsSinceEpoch}';
    final c = Completer<List<Map<String, dynamic>>>();
    _searchReqs[reqId] = c;
    _send({'type': 'search', 'q': query, 'reqId': reqId});
    return c.future.timeout(const Duration(seconds: 4), onTimeout: () {
      _searchReqs.remove(reqId);
      return const [];
    });
  }

  /// Resolve [host] with a few quick retries (~5s worst case). Absorbs the
  /// transient mobile DNS failures (errno 7) that otherwise kill the socket.
  Future<bool> _dnsReady(String host) async {
    for (var i = 0; i < 5; i++) {
      if (!_wantConnected) return false;
      try {
        final r = await InternetAddress.lookup(host).timeout(const Duration(seconds: 4));
        if (r.isNotEmpty) return true;
      } catch (_) {/* transient lookup failure — retry */}
      await Future.delayed(Duration(milliseconds: 400 + 300 * i));
    }
    return false;
  }

  void _onFrame(dynamic raw) {
    Map<String, dynamic> m;
    try { m = (jsonDecode(raw as String) as Map).cast<String, dynamic>(); } catch (_) { return; }
    _lastRecvAt = DateTime.now().millisecondsSinceEpoch; // liveness: a frame arrived
    // Cheap per-connection frame tally (rolled up into hub_disconnected) — lets us
    // confirm a given device is actually RECEIVING live frames over the socket.
    final ft = (m['type'] ?? '').toString();
    if (ft.isNotEmpty && ft != 'pong') _frameCounts[ft] = (_frameCounts[ft] ?? 0) + 1;
    switch (m['type']) {
      case 'pong':
        break;
      case 'sync':
        // Apply MY read high-water marks FIRST, before any message is replayed,
        // so a full re-sync (cursor=0 on every launch) doesn't recount already-
        // read messages as unread. Restores read state on a fresh/2nd device.
        // Bulk-merge to ReadStateStore (one file write) to avoid a load-modify-
        // write race, then emit per-conv events so an open chat list updates now.
        {
          final bulk = <String, int>{};
          for (final r in (m['reads'] as List? ?? const [])) {
            final pair = _readKeyTs((r as Map).cast<String, dynamic>());
            if (pair == null) continue;
            bulk[pair.$1] = pair.$2;
            _emitRead(pair.$1, pair.$2);
          }
          if (bulk.isNotEmpty) ReadStateStore().mergeBulk(bulk);
        }
        {
          // Seed soft-delete flags from the server `hidden` column in ONE write so
          // a fresh device shows my deleted messages as hidden on a cold open.
          final hideBulk = <String, bool>{};
          for (final row in (m['messages'] as List? ?? const [])) {
            final r = (row as Map);
            final cid = (r['client_id'] ?? '').toString();
            if (cid.isNotEmpty) hideBulk[cid] = ((r['hidden'] as num?)?.toInt() ?? 0) == 1;
          }
          if (hideBulk.isNotEmpty) HiddenStore().mergeBulk(hideBulk);
        }
        for (final row in (m['messages'] as List? ?? const [])) {
          // Per-row guard: a single malformed message must not abort the loop and
          // drop every message after it (e.g. a marketplace deal card).
          try {
            _ingestMsg((row as Map).cast<String, dynamic>(), fromSync: true);
          } catch (_) {/* skip this row, keep ingesting the rest */}
        }
        for (final r in (m['receipts'] as List? ?? const [])) {
          _ingestReceipt((r as Map).cast<String, dynamic>());
        }
        // Authoritative call-log snapshot — reconcile the on-device history with
        // every other device on the account (adds, per-row deletes, clears).
        {
          final calls = (m['calls'] as List? ?? const [])
              .map((e) => (e as Map).cast<String, dynamic>())
              .toList();
          if (calls.isNotEmpty) {
            try { unawaited(CallLogStore().applyServerSnapshot(calls)); } catch (_) {/* bad call rows never abort the sync */}
          }
        }
        // After a backlog/restore sync the local DB now holds conversations that
        // P13-A sync_catchup: one row per (re)connect cursor sync.
        {
          final msgs = (m['messages'] as List? ?? const []).length;
          if (msgs > 0) _maybeEmitTtfm();
          Analytics.capture('sync_catchup', {
            'messages': msgs,
            'ms': _syncStartedAt > 0 ? DateTime.now().millisecondsSinceEpoch - _syncStartedAt : 0,
            'cursor_gap': msgs,
            'trigger': _syncTrigger,
          });
          _syncTrigger = 'login'; // reset; the next cycle re-labels itself
        }
        break;
      case 'msg':
        _maybeEmitTtfm();
        // P13-A msg_delivery_latency: now − InboxDO append instant (server_ts).
        {
          final st = (m['server_ts'] as num?)?.toInt();
          if (st != null && st > 0) {
            final lat = DateTime.now().millisecondsSinceEpoch - st;
            if (lat >= 0 && lat < 600000) {
              Analytics.capture('msg_delivery_latency', {'ms': lat, 'via': 'live'});
            }
          }
        }
        _ingestMsg(m);
        break;
      case 'receipt':
        _ingestReceipt(m);
        break;
      case 'read':
        _ingestRead(m);
        break;
      case 'hide':
        _ingestHide(m);
        break;
      case 'del':
        // Delete-for-everyone control frame (never a stored message → can't render
        // as raw text). Redact durably + live on this device.
        _ingestDel(m);
        break;
      case 'call':
        // A new call-log entry recorded on another of MY devices → mirror it here.
        // Guarded: a malformed call frame must never crash the socket handler (and
        // take a co-arriving deal message down with it).
        try {
          unawaited(CallLogStore().applyRemoteAdd(CallEntry.fromServer(m)));
        } catch (_) {/* tolerate a bad call frame */}
        break;
      case 'call_del':
        // One call-log entry deleted on another of MY devices.
        unawaited(CallLogStore().applyRemoteDelete((m['entry_id'] ?? '').toString()));
        break;
      case 'call_clear':
        // Whole call history cleared on another of MY devices.
        unawaited(CallLogStore().applyRemoteClear());
        break;
      case 'searchResults':
        {
          final reqId = (m['reqId'] ?? '').toString();
          final c = _searchReqs.remove(reqId);
          if (c != null && !c.isCompleted) {
            c.complete(((m['results'] as List?) ?? const [])
                .map((e) => (e as Map).cast<String, dynamic>())
                .toList());
          }
        }
        break;
      case 'storage':
        // AvaStorage live summary (Phase 4): transient system event — fan to any
        // open AvaStorage screen. Same multiplexed socket, no extra connection.
        _storage.add(m);
        break;
      case 'ava_stream':
        {
          // Live @ava token preview — derive the convKey the open thread uses so
          // it can filter to its own conversation, then fan out (transient).
          final conv = (m['conv'] ?? '').toString();
          final myUid = _myUid ?? '';
          final convKey = conv.startsWith('dm_')
              ? '1:${dmPeer(conv, myUid) ?? conv}'
              : 'g:$conv';
          _avaStream.add({...m, 'convKey': convKey});
        }
        break;
      case 'safety_flag':
        {
          // F6: guardian flagged an incoming message. Persist it per-account keyed
          // by msg_id (so the red bubble survives reopen), then fan out to the open
          // thread. Server posts this to the RECIPIENT only — never the sender.
          final conv = (m['conv'] ?? '').toString();
          final msgId = (m['msg_id'] ?? '').toString();
          final category = (m['category'] ?? '').toString();
          if (msgId.isNotEmpty) {
            unawaited(SafetyFlagStore().put(msgId, conv: conv, category: category));
            final myUid = _myUid ?? '';
            final convKey = conv.startsWith('dm_')
                ? '1:${dmPeer(conv, myUid) ?? conv}'
                : 'g:$conv';
            _safetyFlags.add({
              'convKey': convKey, 'conv': conv, 'msg_id': msgId, 'category': category,
            });
          }
        }
        break;
    }
  }

  void _ingestMsg(Map<String, dynamic> r, {bool fromSync = false}) {
    final id = (r['id'] as num?)?.toInt() ?? 0;
    if (id > _cursor) { _cursor = id; _scheduleCursorPersist(); }
    final conv = (r['conv'] ?? '').toString();
    final sender = (r['sender'] ?? '').toString();
    final body = (r['body'] ?? '').toString();           // our app envelope JSON
    final clientId = (r['client_id'] ?? '').toString();
    final createdMs = (r['created_at'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch;
    final createdSec = createdMs > 2000000000 ? createdMs ~/ 1000 : createdMs; // tolerate s/ms
    final rumorId = clientId.isNotEmpty ? clientId : 'srv_$id';
    if (!_seen.add(rumorId)) return; // dedup optimistic echo + re-sync

    final myUid = _myUid ?? '';
    final mine = sender == myUid;
    final convKey = conv.startsWith('dm_')
        ? '1:${dmPeer(conv, myUid) ?? sender}'
        : 'g:$conv';

    var isReceipt = false;
    try {
      final env = jsonDecode(body);
      if (env is Map) {
        if (env['t'] == 'receipt') isReceipt = true;
        // Delete-for-everyone from a peer: record the tombstone DURABLY the instant
        // it's ingested — independent of whether the target chat is open — so it
        // survives and re-applies on the next cold open. (My own delete echoes back
        // as mine → nothing to tombstone on my side; the owner keeps it via Undo.)
        if (!mine && (env['t'] == 'del' || env['t'] == 'gdel')) {
          final target = (env['target'] ?? '').toString();
          final isGroup = env['t'] == 'gdel';
          if (target.isNotEmpty) {
            DeletedStore().add(target).then((added) {
              if (added) {
                Analytics.capture('chat_delete_applied', {
                  'delete_id': target,
                  'source': fromSync ? 'sync_seed' : 'live_socket',
                  'group': isGroup,
                });
              }
            });
          }
        }
      }
    } catch (_) {}

    if (!isReceipt) {
      final list = _byConv.putIfAbsent(convKey, () => []);
      if (!list.any((x) => x.rumorId == rumorId)) {
        list.add(DmMessage(rumorId: rumorId, mine: mine, payload: body, createdAt: createdSec));
        try {
          Db.I.upsertMessage(MessagesCompanion.insert(
              rumorId: rumorId, convKey: convKey, mine: mine, payload: body, createdAt: createdSec));
          if (!_dbLogged) { _dbLogged = true; AvaLog.I.log('db', 'sqlite: storing messages locally ✓'); }
        } catch (_) {}
      }
    }
    _incoming.add(HubEvent(convKey, sender, myUid, mine, rumorId, body, createdSec));
  }

  /// Inject a LOCALLY-created message (e.g. the optimistic "your agent is
  /// negotiating…" bubble on Marketplace "Contact agent") as if it had just
  /// arrived. Persists it, adds it to the in-memory thread, and — crucially —
  /// emits it on [incoming] so the chat LIST materialises the peer's contact +
  /// thread LIVE (via its `text` handler), instead of the write sitting silently
  /// in storage until the next app reload. Shows as NOT mine so the list treats
  /// it like an inbound and surfaces the thread with an unread nudge.
  void injectLocal({
    required String peerUid,
    required String payload,
    int? createdAt,
    String? rumorId,
  }) {
    final myUid = _myUid ?? '';
    final ts = createdAt ?? DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final rid = rumorId ?? 'local_${peerUid}_$ts';
    if (!_seen.add(rid)) return; // idempotent — don't double-insert on re-tap
    final convKey = '1:$peerUid';
    final list = _byConv.putIfAbsent(convKey, () => []);
    if (!list.any((x) => x.rumorId == rid)) {
      list.add(DmMessage(rumorId: rid, mine: false, payload: payload, createdAt: ts));
      try {
        Db.I.upsertMessage(MessagesCompanion.insert(
            rumorId: rid, convKey: convKey, mine: false, payload: payload, createdAt: ts));
      } catch (_) {}
    }
    _incoming.add(HubEvent(convKey, peerUid, myUid, false, rid, payload, ts));
  }

  // Global (device-level, NOT account-scoped) queue of delete-for-everyone
  // redactions that arrived via a high-priority FCM 'del' push while the app was
  // backgrounded/killed. The background isolate has no AccountScope, so it parks
  // them here (DiskCache.*Global); [drainPendingDeletes] applies them the instant
  // the app is alive and the account scope is known. Entry format: 'conv\ttarget'.
  static const pendingDeletesKey = 'avatok_pending_deletes';

  // Global (device-level) queue of call-log ops that arrived via a silent FCM wake
  // while the app was asleep. The background isolate has no AccountScope, so it
  // parks them here; [drainPendingCallOps] applies them to the scoped CallLogStore
  // the instant the app is alive. Entry format: 'del\t<entry_id>' or 'clear'.
  static const pendingCallOpsKey = 'avatok_pending_call_ops';

  /// Drain call-log deletes/clears queued by the background FCM isolate into the
  /// account-scoped CallLogStore. Idempotent; clears the queue when done. Called on
  /// start + every reconnect, so a delete/clear received while asleep lands on the
  /// next foreground. A 'clear' supersedes everything, so it short-circuits.
  Future<void> drainPendingCallOps() async {
    final raw = await DiskCache.readGlobal(pendingCallOpsKey);
    if (raw == null || raw.isEmpty) return;
    List<dynamic> list;
    try { list = jsonDecode(raw) as List; } catch (_) { list = const []; }
    if (list.isEmpty) { await DiskCache.deleteGlobal(pendingCallOpsKey); return; }
    final store = CallLogStore();
    if (list.any((e) => e.toString() == 'clear')) {
      await store.applyRemoteClear();
    } else {
      for (final e in list) {
        final s = e.toString();
        if (s.startsWith('del\t')) await store.applyRemoteDelete(s.substring(4));
      }
    }
    Analytics.capture('call_log_ops_drained', {'count': list.length});
    await DiskCache.deleteGlobal(pendingCallOpsKey);
  }

  /// Apply a delete-for-everyone in (near) realtime: durably tombstone the target
  /// on THIS device and, if its thread is open, redact it live. Called from the
  /// foreground FCM 'del' handler and when draining the background queue. Safe to
  /// call repeatedly (DeletedStore + the thread tombstone are idempotent).
  Future<void> applyRemoteDelete(String target, {String conv = '', String source = 'push_fg'}) async {
    if (target.isEmpty) return;
    final added = await DeletedStore().add(target); // durable: survives reopen / cache rebuild
    if (added) {
      Analytics.capture('chat_delete_applied', {
        'delete_id': target,
        'source': source, // push_fg (foreground FCM) | push_drained (queued in bg)
        'conv_kind': conv.startsWith('dm_') ? 'dm' : (conv.isEmpty ? 'unknown' : 'group'),
      });
    }
    if (conv.isEmpty) return;
    final myUid = _myUid ?? '';
    final convKey = conv.startsWith('dm_') ? '1:${dmPeer(conv, myUid) ?? conv}' : 'g:$conv';
    // Re-emit as a {t:'del'} control so an OPEN thread tombstones it live via its
    // existing _applyDelete path (mine=false → applies, like a peer's live delete).
    _incoming.add(HubEvent(convKey, myUid, myUid, false, 'del_$target',
        jsonEncode({'t': 'del', 'target': target}),
        DateTime.now().millisecondsSinceEpoch ~/ 1000));
  }

  /// Drain redactions queued by the background FCM isolate into the account-scoped
  /// DeletedStore. Idempotent; clears the queue when done. Called on app start +
  /// every reconnect, so a delete received while backgrounded lands immediately on
  /// the next foreground — no manual sync needed.
  Future<void> drainPendingDeletes() async {
    final raw = await DiskCache.readGlobal(pendingDeletesKey);
    if (raw == null || raw.isEmpty) return;
    List<dynamic> list;
    try { list = jsonDecode(raw) as List; } catch (_) { list = const []; }
    if (list.isEmpty) { await DiskCache.deleteGlobal(pendingDeletesKey); return; }
    for (final e in list) {
      final s = e.toString();
      final i = s.indexOf('\t');
      await applyRemoteDelete(i >= 0 ? s.substring(i + 1) : s,
          conv: i >= 0 ? s.substring(0, i) : '', source: 'push_drained');
    }
    // Realtime-on-resume signal: how many background-pushed deletes the app just
    // flushed. A high count or a steady stream here means deletes are landing via
    // the queue (app was asleep) rather than the live socket — useful for triage.
    Analytics.capture('chat_delete_drained', {'count': list.length});
    await DiskCache.deleteGlobal(pendingDeletesKey);
  }

  // A DELETE-FOR-EVERYONE control frame from a peer (server broadcasts this instead
  // of storing a renderable del message). Apply the redaction durably + live.
  void _ingestDel(Map<String, dynamic> r) {
    final conv = (r['conv'] ?? '').toString();
    final target = (r['target'] ?? '').toString();
    if (target.isEmpty) return;
    applyRemoteDelete(target, conv: conv, source: 'live_socket');
  }

  // A SOFT-DELETE/Undo (delete-for-me, the owner side of delete-for-everyone, or
  // Undo) from one of MY OTHER devices, delivered LIVE over the InboxDO socket.
  void _ingestHide(Map<String, dynamic> r) {
    final conv = (r['conv'] ?? '').toString();
    final target = (r['target'] ?? '').toString();
    if (target.isEmpty) return;
    applyRemoteHide(target, r['hidden'] == true, conv: conv, source: 'live_socket');
  }

  // Global (device-level) queue of message hide/undo ops that arrived via a silent
  // FCM 'hide' wake while the app was asleep (the background isolate has no
  // AccountScope). [drainPendingHides] flushes them into the scoped HiddenStore on
  // the next foreground. Entry format: 'conv\ttarget\t0|1' (1 = hidden, 0 = undo).
  static const pendingHidesKey = 'avatok_pending_hides';

  /// Apply a hide/undo to THIS device in (near) realtime: durably set the flag and,
  /// if the thread is open, hide/un-hide live. Used by the live 'hide' frame, the
  /// foreground FCM 'hide' handler, and the background-queue drain. Idempotent — a
  /// repeat delivery that doesn't change the flag is a no-op (HiddenStore.set=false).
  Future<void> applyRemoteHide(String target, bool hidden, {String conv = '', String source = 'push_fg'}) async {
    if (target.isEmpty) return;
    final changed = await HiddenStore().set(target, hidden); // durable across cold opens
    if (changed) {
      Analytics.capture('chat_hide_applied', {'target': target, 'hidden': hidden, 'source': source});
    }
    if (conv.isEmpty) return;
    final myUid = _myUid ?? '';
    final convKey = conv.startsWith('dm_') ? '1:${dmPeer(conv, myUid) ?? conv}' : 'g:$conv';
    // Re-emit as a {t:'hide'} event so an OPEN thread applies it live via _applyHide.
    _incoming.add(HubEvent(convKey, myUid, myUid, true, 'hide_${target}_$hidden',
        jsonEncode({'t': 'hide', 'target': target, 'hidden': hidden}),
        DateTime.now().millisecondsSinceEpoch ~/ 1000));
  }

  /// Drain hide/undo ops queued by the background FCM isolate into the scoped
  /// HiddenStore. Idempotent; clears the queue when done. Called on app start +
  /// every reconnect, so a hide/undo from another device lands on the next
  /// foreground rather than waiting for the periodic re-sync.
  Future<void> drainPendingHides() async {
    final raw = await DiskCache.readGlobal(pendingHidesKey);
    if (raw == null || raw.isEmpty) return;
    List<dynamic> list;
    try { list = jsonDecode(raw) as List; } catch (_) { list = const []; }
    if (list.isEmpty) { await DiskCache.deleteGlobal(pendingHidesKey); return; }
    for (final e in list) {
      final parts = e.toString().split('\t');
      if (parts.length < 3) continue;
      await applyRemoteHide(parts[1], parts[2] == '1', conv: parts[0], source: 'push_drained');
    }
    Analytics.capture('chat_hide_drained', {'count': list.length});
    await DiskCache.deleteGlobal(pendingHidesKey);
  }

  void _ingestReceipt(Map<String, dynamic> r) {
    final conv = (r['conv'] ?? '').toString();
    final peer = (r['peer'] ?? '').toString();
    final readId = (r['read_id'] as num?)?.toInt();
    final deliveredId = (r['delivered_id'] as num?)?.toInt();
    final status = readId != null ? 'read' : 'delivered';
    final ts = (readId ?? deliveredId ?? 0);
    final myUid = _myUid ?? '';
    final convKey = conv.startsWith('dm_') ? '1:${dmPeer(conv, myUid) ?? peer}' : 'g:$conv';
    final payload = jsonEncode({'t': 'receipt', 'status': status, 'ts': ts});
    _incoming.add(HubEvent(convKey, peer, myUid, false, 'rcpt_${conv}_$ts', payload, ts));
  }

  /// Parse a server read row → (convKey, readSec). Null if unusable.
  (String, int)? _readKeyTs(Map<String, dynamic> r) {
    final conv = (r['conv'] ?? '').toString();
    if (conv.isEmpty) return null;
    final tsRaw = (r['read_ts'] as num?)?.toInt() ?? 0;
    if (tsRaw <= 0) return null;
    final readSec = tsRaw > 2000000000 ? tsRaw ~/ 1000 : tsRaw; // tolerate s/ms
    final myUid = _myUid ?? '';
    final convKey = conv.startsWith('dm_') ? '1:${dmPeer(conv, myUid) ?? conv}' : 'g:$conv';
    return (convKey, readSec);
  }

  /// Emit a 'read' HubEvent so an open chat list clears that conv's badge now.
  void _emitRead(String convKey, int readSec) {
    final myUid = _myUid ?? '';
    _incoming.add(HubEvent(
        convKey, myUid, myUid, true, 'read_${convKey}_$readSec',
        jsonEncode({'t': 'read', 'read_ts': readSec}), readSec));
  }

  /// A single live 'read' frame (MY read high-water, e.g. from a 2nd device).
  /// Persists to ReadStateStore + emits the event.
  void _ingestRead(Map<String, dynamic> r) {
    final pair = _readKeyTs(r);
    if (pair == null) return;
    ReadStateStore().setRead(pair.$1, pair.$2); // single conv → no bulk race
    _emitRead(pair.$1, pair.$2);
  }

  /// Persist the cursor shortly after the last message of a burst (debounced —
  /// one small file write per sync, not one per message). On the next launch we
  /// resume from here instead of re-pulling everything.
  void _scheduleCursorPersist() {
    _cursorPersistTimer?.cancel();
    _cursorPersistTimer = Timer(const Duration(seconds: 2),
        () => DiskCache.write(_kCursorKey, _cursor.toString()));
  }

  /// Messages for a conversation seen this session (instant, in-memory).
  List<DmMessage> messagesFor(String convKey) => List.of(_byConv[convKey] ?? const []);

  NostrClient? get client => _stub;
}
