import '../api_client.dart';

/// [HF-CALL-MODES-E2] The three things the influencer can choose (hf_hosts.call_mode).
const List<String> kHostModes = ['online', 'bookings_only', 'offline'];

/// What `GET/PUT /api/hosts/me/presence` says. Old servers send only `presence`; new ones add `mode`, `onCall`, `queue`.
class PresenceState {
  const PresenceState({
    required this.presence,
    required this.mode,
    this.onCall = false,
    this.queueWaiting = 0,
    this.queuePaused = false,
    this.queueOpen = false,
  });

  factory PresenceState.fromJson(Map<String, dynamic> j) {
    final p = j['presence'];
    final presence = p == 'online' || p == 'busy' ? p as String : 'offline';
    final m = j['mode'];
    // Old payload (no mode): online/busy mean Online, offline means "Bookings only" (spec D6: the shipped app's Offline).
    final mode = m is String && kHostModes.contains(m) ? m : (presence == 'offline' ? 'bookings_only' : 'online');
    final q = j['queue'];
    final qm = q is Map ? q : const <String, Object?>{};
    final w = qm['waiting'];
    return PresenceState(
      presence: presence,
      mode: mode,
      onCall: j['onCall'] == true || presence == 'busy',
      queueWaiting: w is num ? w.toInt() : 0,
      queuePaused: qm['paused'] == true,
      queueOpen: qm['open'] == true,
    );
  }

  /// `online`, `busy` or `offline` (derived by the server; the old field).
  final String presence;

  /// `online`, `bookings_only` or `offline`.
  final String mode;
  final bool onCall;
  final int queueWaiting;
  final bool queuePaused;
  final bool queueOpen;
}

/// Influencer presence, the feed's online count and "Notify me" (HF-WIRE-5).
///
/// - `GET/PUT /api/hosts/me/presence` -> `{ok, presence: online|busy|offline}` and, with call modes on, `mode`, `onCall`,
///   `queue:{waiting, paused, open}`. `busy` is set by the server while a call is running. PUT takes `{mode}` or the old
///   `{online:boolean}` (true = Online, false = Bookings only).
/// - `GET /api/hf/online-count` -> `{count}` (public, cached 60 s).
/// - `GET/POST/DELETE /api/hf/hosts/:slug/notify` -> `{subscribed}`; one WhatsApp when she goes online.
class PresenceRepo {
  const PresenceRepo(this._api);

  final ApiClient _api;

  /// `online`, `busy` or `offline`.
  Future<String> fetch() async => (await fetchState()).presence;

  /// Everything the server says about her line.
  Future<PresenceState> fetchState() async => PresenceState.fromJson(await _api.getJson('/api/hosts/me/presence'));

  /// Returns the presence the server ended up with (can be `busy` when going online mid-call).
  Future<String> set({required bool online}) async =>
      PresenceState.fromJson(await _api.putJson('/api/hosts/me/presence', body: {'online': online})).presence;

  /// [HF-CALL-MODES-E2] Picks one of [kHostModes].
  Future<PresenceState> setMode(String mode) async =>
      PresenceState.fromJson(await _api.putJson('/api/hosts/me/presence', body: {'mode': mode}));

  /// Public. Throws `ApiException` on any failure (the pill hides itself).
  Future<int> onlineCount() async {
    final j = await _api.getJson('/api/hf/online-count', auth: false);
    final c = j['count'];
    return c is num ? c.toInt() : 0;
  }

  /// Needs an account with a verified WhatsApp number.
  Future<void> notifyMe(String slug) async {
    await _api.postJson('/api/hf/hosts/${Uri.encodeComponent(slug)}/notify');
  }

  Future<bool> isSubscribed(String slug) async {
    final j = await _api.getJson('/api/hf/hosts/${Uri.encodeComponent(slug)}/notify');
    return j['subscribed'] == true;
  }
}
