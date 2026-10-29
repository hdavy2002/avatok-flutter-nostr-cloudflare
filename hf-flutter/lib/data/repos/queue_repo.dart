import '../api_client.dart';
import '../models/queue.dart';
import '../photos_gate.dart'; // [HF-PHOTO-CROP-APP]

/// [HF-CALL-MODES-E2] The call queue (dark behind `hfCallQueueEnabled`).
///
/// Fan side:
/// - `POST   /api/hf/hosts/:slug/queue` -> `{entryId, position, waiting}`; errors `queue_closed`, `queue_full`,
///   `already_queued` (+ `hostSlug`), `low_balance` (+ `shortfallPaise`), `not_verified`.
/// - `DELETE /api/hf/hosts/:slug/queue` -> leave.
/// - `GET    /api/hf/queue/me` -> `{entry: null | {entryId, hostSlug, hostName, position, status, callId?}}`. Polled.
/// Influencer side:
/// - `GET/PUT /api/hosts/me/queue {paused}` -> `{waiting, paused, entries:[{position, firstName, joinedAt}]}`.
class QueueRepo {
  const QueueRepo(this._api);

  final ApiClient _api;

  Future<QueueJoinResult> join(String slug) async =>
      QueueJoinResult.fromJson(await PhotosGate.watch(_api.postJson('/api/hf/hosts/${Uri.encodeComponent(slug)}/queue'))); // [HF-PHOTO-CROP-APP]

  Future<void> leave(String slug) async {
    await _api.deleteJson('/api/hf/hosts/${Uri.encodeComponent(slug)}/queue');
  }

  Future<MyQueue> mine() async => MyQueue.fromJson(await _api.getJson('/api/hf/queue/me'));

  Future<HostQueue> hostQueue() async => HostQueue.fromJson(await _api.getJson('/api/hosts/me/queue'));

  Future<HostQueue> setPaused(bool paused) async =>
      HostQueue.fromJson(await _api.putJson('/api/hosts/me/queue', body: {'paused': paused}));
}
