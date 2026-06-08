// AvaChat calls adapter (Phase 3) — full 0xchat call UI on our CallRoom + TURN.
//
// Beautiful alignment: 0xchat's NIP-100 signaling already uses kind 25050
// (see external/0xchat-core/lib/src/chat/contacts/contacts+calling.dart →
// Nip100.offer/answer/candidate, kind = 25050). Our relay already gates AND
// push-enqueues kind 25050 (relay/src/relay_do.ts PRIVATE_KINDS + PUSH_KINDS).
// So signaling flows over our relay UNCHANGED.
//
// Only two things must be re-homed:
//   1. ICE/TURN servers → Cloudflare Realtime TURN (minted at $iceUrl), instead
//      of 0xchat's public/self-host ICE defaults.
//   2. The 1:1 invariant (AvaTOK rule): no group-call entry points; reject any
//      attempt to ring more than one peer. Our CallRoom DO independently caps a
//      room at 2 peers, but we ALSO guard client-side (defense in depth).

import 'avachat_config.dart';

/// An ICE server entry for flutter_webrtc's RTCPeerConnection config.
class AvaIceServer {
  final List<String> urls;
  final String? username;
  final String? credential;
  const AvaIceServer({required this.urls, this.username, this.credential});

  Map<String, dynamic> toRtc() => {
        'urls': urls,
        if (username != null) 'username': username,
        if (credential != null) 'credential': credential,
      };
}

class AvaChatCalls {
  AvaChatCalls._();
  static final AvaChatCalls instance = AvaChatCalls._();

  List<AvaIceServer> _ice = const [];

  /// 0xchat reads ICE servers when building its RTCPeerConnection. Feed it this
  /// list (mapped via toRtc()) so media flows through Cloudflare TURN.
  List<Map<String, dynamic>> get rtcIceServers =>
      _ice.map((e) => e.toRtc()).toList(growable: false);

  /// Mint short-lived TURN credentials from our calls Worker.
  Future<void> configureIceServers() async {
    // TODO(build): GET $iceUrl (NIP-98 + Clerk via AvaChatTransport) → returns
    // {iceServers:[{urls,username,credential}]} from Cloudflare Realtime TURN.
    // Cache until expiry; refresh before each call setup.
    // Placeholder keeps STUN so the graft compiles and degrades gracefully.
    _ice = const [
      AvaIceServer(urls: ['stun:stun.cloudflare.com:3478']),
    ];
  }

  /// 1:1 guard — call this from every call entry point in the grafted UI.
  /// Mirrors the app rule and the server CallRoom 2-peer cap. Throws on misuse.
  void assertOneToOne({String? groupId, required int participantCount}) {
    if (!AvaChatConfig.oneToOneCallsOnly) return;
    if (groupId != null && groupId.isNotEmpty) {
      throw StateError('AvaChat: group calls are not allowed (AvaConsult only).');
    }
    if (participantCount > 2) {
      throw StateError('AvaChat: calls are strictly 1:1 (max 2 peers).');
    }
  }

  /// Whether a call button may render for this thread. Group threads keep full
  /// messaging but NEVER a call entry point.
  bool callButtonAllowed({required bool isGroupThread}) =>
      !(AvaChatConfig.oneToOneCallsOnly && isGroupThread);
}
