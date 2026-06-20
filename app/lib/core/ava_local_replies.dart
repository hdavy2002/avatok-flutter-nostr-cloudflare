/// AvaLocalReplies — a tiny broadcast bus for on-device Ava answers in AvaTok
/// threads.
///
/// AvaTok's Ava bubbles are normally posted server-side (the worker writes them
/// into the InboxDO, which syncs back). When Local Ava AI is active we answer
/// `@ava` ON-DEVICE (offline-capable), so there's no server round-trip to render
/// the bubble. This bus lets the on-device handler ([AvaInvoke]) push the answer
/// to whichever chat thread is open for that conversation; the thread subscribes
/// by `convKey` and renders it as a normal Ava bubble. Additive — it does not
/// touch the existing server message pipeline.
library;

import 'dart:async';

class AvaLocalReply {
  final String convKey; // '1:<peerHex>' | 'g:<gid>'
  final String text;
  const AvaLocalReply(this.convKey, this.text);
}

class AvaLocalReplies {
  AvaLocalReplies._();
  static final AvaLocalReplies I = AvaLocalReplies._();

  final StreamController<AvaLocalReply> _ctrl =
      StreamController<AvaLocalReply>.broadcast();

  Stream<AvaLocalReply> get stream => _ctrl.stream;

  /// Post an on-device Ava answer into the conversation [convKey].
  void post(String convKey, String text) =>
      _ctrl.add(AvaLocalReply(convKey, text));
}
