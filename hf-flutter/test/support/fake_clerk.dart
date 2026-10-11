import 'dart:convert';

import 'package:hf_app/core/auth/clerk_client.dart';

/// A [ClerkApi] with no network. `user` null means signed out.
class FakeClerk implements ClerkApi {
  FakeClerk({this.user});

  ClerkUser? user;
  final List<String> tickets = <String>[];

  /// What [signInWithTicket] answers with. Default: sign in as [signInAs].
  ClerkStep? ticketResult;
  ClerkUser signInAs = const ClerkUser(id: 'user_test');

  @override
  Future<ClerkStep> signInWithTicket(String ticket) async {
    tickets.add(ticket);
    final r = ticketResult;
    if (r != null) {
      user = r.user;
      return r;
    }
    user = signInAs;
    return ClerkStep.complete(signInAs);
  }

  @override
  Future<ClerkUser?> currentUser() async => user;

  @override
  Future<String?> sessionToken({bool forceRefresh = false}) async {
    final identity = user;
    if (identity == null) return null;
    String part(Map<String, Object> payload) => base64Url.encode(utf8.encode(jsonEncode(payload))).replaceAll('=', '');
    // Deliberately unsigned test evidence; the fake API never validates a signature.
    return '${part({'alg': 'none', 'typ': 'JWT'})}.${part({'sub': identity.id})}.test-signature';
  }

  @override
  Future<void> signOut() async => user = null;

  @override
  Future<void> warmSession() async {}
}
