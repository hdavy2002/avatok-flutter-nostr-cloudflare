import 'dart:typed_data';

import '../api_client.dart';
import '../api_exception.dart';
import '../models/support.dart';

/// [HF-SUPPORT-APP] The customer side of Contact Support: `/api/hf/support/*` (worker, HF-SUPPORT contract v1).
///
/// - `GET  tickets?status=open|solved|closed|all`  -> `{ok, tickets:[...]}`
/// - `POST tickets {category, subject, message, attachmentIds?, meta?}` -> `{ok, ticket:{number,...}}`
/// - `GET  tickets/:number` -> `{ok, ticket, messages}` (marks the ticket read)
/// - `POST tickets/:number/reply {message, attachmentIds?}`, `.../solve`, `.../reopen`
/// - `POST attachments` raw body + `content-type` + `x-file-name` (percent-encoded) -> `{ok, id, name, size}`
/// - `GET  attachments/:id` -> the file (needs the sign-in, so it is fetched through the API client)
class SupportRepo {
  const SupportRepo(this._api);

  final ApiClient _api;

  static const String _base = '/api/hf/support';

  /// Largest single file the server takes (10 MB).
  static const int maxFileBytes = 10 * 1024 * 1024;

  Future<List<SupportTicket>> tickets({String status = 'all'}) async {
    final j = await _api.getJson('$_base/tickets', query: {'status': status});
    return SupportTicket.listFrom(j['tickets']);
  }

  /// Opens a ticket. Returns the new ticket (its `number` is what the success screen shows).
  Future<SupportTicket> create({
    required String category,
    required String subject,
    required String message,
    List<String> attachmentIds = const <String>[],
    Map<String, Object?>? meta,
  }) async {
    final j = await _api.postJson('$_base/tickets', body: {
      'category': category,
      'subject': subject.trim(),
      'message': message.trim(),
      if (attachmentIds.isNotEmpty) 'attachmentIds': attachmentIds,
      if (meta != null && meta.isNotEmpty) 'meta': meta,
    });
    final t = j['ticket'];
    if (t is! Map || (t['number'] ?? '').toString().isEmpty) throw ApiException.parse(200);
    return SupportTicket.fromJson(Map<String, dynamic>.from(t));
  }

  Future<SupportThread> ticket(String number) async =>
      SupportThread.fromJson(await _api.getJson('$_base/tickets/${Uri.encodeComponent(number)}'));

  Future<void> reply(String number, String message, {List<String> attachmentIds = const <String>[]}) async {
    await _api.postJson('$_base/tickets/${Uri.encodeComponent(number)}/reply', body: {
      'message': message.trim(),
      if (attachmentIds.isNotEmpty) 'attachmentIds': attachmentIds,
    });
  }

  Future<void> solve(String number) async {
    await _api.postJson('$_base/tickets/${Uri.encodeComponent(number)}/solve');
  }

  Future<void> reopen(String number) async {
    await _api.postJson('$_base/tickets/${Uri.encodeComponent(number)}/reopen');
  }

  /// Uploads one file. The name travels in a header, which cannot carry non-ASCII letters, so it is percent-encoded (UTF-8).
  Future<UploadedAttachment> upload(Uint8List bytes, {required String contentType, required String fileName}) async {
    final j = await _api.postBytes(
      '$_base/attachments',
      bytes,
      contentType: contentType,
      headers: {'x-file-name': Uri.encodeComponent(fileName)},
    );
    final id = (j['id'] ?? '').toString();
    if (id.isEmpty) throw ApiException.parse(200);
    final size = j['size'];
    return UploadedAttachment(id: id, name: (j['name'] ?? fileName).toString(), size: size is num ? size.toInt() : bytes.length);
  }

  /// The bytes of an attachment (a screenshot or PDF on a message).
  Future<List<int>> attachmentBytes(String id) => _api.getBytes('$_base/attachments/${Uri.encodeComponent(id)}');
}
