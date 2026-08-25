import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/features/commercial_getstream/commercial_getstream_handoff.dart';
import 'package:avatok_call/features/commercial_getstream/commercial_getstream_screens.dart';
import 'package:avatok_call/features/commercial_getstream/commercial_consult_screens.dart';
import 'package:avatok_call/identity/identity.dart' show AccountScope;

class _Gateway implements CommercialGetStreamJoinGateway {
  int calls = 0;

  @override
  Future<CommercialGetStreamJoinHandoff> authorize(
    CommercialGetStreamJoinRequest request,
  ) async {
    calls++;
    throw StateError('must not authorize while disabled');
  }
}

class _Connector implements CommercialGetStreamConnector {
  @override
  Future<CommercialGetStreamSession> connect(
    CommercialGetStreamJoinHandoff handoff,
  ) => throw StateError('must not connect while disabled');
}

void main() {
  test('viewer is receive-only while commercial publishers start enabled', () {
    final viewer = CommercialGetStreamMediaPlan.forRole(
      CommercialGetStreamRole.viewer,
    );
    expect(viewer.canPublish, isFalse);
    expect(viewer.cameraEnabled, isFalse);
    expect(viewer.microphoneEnabled, isFalse);

    final host = CommercialGetStreamMediaPlan.forRole(
      CommercialGetStreamRole.host,
    );
    expect(host.canPublish, isTrue);
    expect(host.cameraEnabled, isTrue);
    expect(host.microphoneEnabled, isTrue);
  });

  testWidgets('receive-only room controls expose no publish controls',
      (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: CommercialGetStreamRoomControls(
        canPublish: false,
        muted: true,
        cameraOff: true,
        onToggleMute: () async {},
        onToggleCamera: () async {},
        onLeave: () async {},
      ),
    ));

    expect(find.text('Mute'), findsNothing);
    expect(find.text('Unmute'), findsNothing);
    expect(find.text('Camera off'), findsNothing);
    expect(find.text('Camera on'), findsNothing);
    expect(find.text('Leave'), findsOneWidget);
  });

  test('parses the actual commercial route response shape', () {
    // The Worker returns lane/kind/token/token_expires_at and deliberately
    // omits provider/user_id; the parser binds the token to AccountScope.
    final previous = AccountScope.id;
    AccountScope.id = 'user-1';
    addTearDown(() => AccountScope.id = previous);
    final handoff = CommercialGetStreamJoinHandoff.fromServer(
      {
        'ok': true,
        'lane': 'commercial',
        'kind': 'live_event',
        'session_id': 'live_listing_1',
        'api_key': 'key',
        'token': 'token',
        'token_expires_at': DateTime.now().millisecondsSinceEpoch ~/ 1000 + 60,
        'call_type': 'avatok_livestream',
        'call_id': 'live_listing_1',
        'role': 'viewer',
      },
      expectedProduct: CommercialGetStreamProduct.liveEvent,
      expectedRole: CommercialGetStreamRole.viewer,
    );
    expect(handoff.userId, 'user-1');
    expect(handoff.provider, 'getstream');
    expect(handoff.mediaPlan.canPublish, isFalse);
  });

  test('server handoff rejects a client/provider mismatch', () {
    expect(
      () => CommercialGetStreamJoinHandoff.fromServer(
        {
          'lane': 'commercial',
          'provider': 'cloudflare',
          'kind': 'live_event',
          'role': 'viewer',
          'api_key': 'key',
          'user_id': 'user',
          'token': 'token',
          'call_type': 'livestream',
          'call_id': 'server-room',
          'session_id': 'session',
          'token_expires_at': DateTime.now().millisecondsSinceEpoch ~/ 1000 + 60,
        },
        expectedProduct: CommercialGetStreamProduct.liveEvent,
        expectedRole: CommercialGetStreamRole.viewer,
      ),
      throwsFormatException,
    );
  });

  testWidgets('commercial room fails closed when join switch is disabled',
      (tester) async {
    final gateway = _Gateway();
    await tester.pumpWidget(MaterialApp(
      home: CommercialLiveViewerScreen(
        listingId: 'listing',
        entitlementId: 'entitlement',
        title: 'Event',
        gateway: gateway,
        connector: _Connector(),
        flags: const CommercialGetStreamJoinFlags(
          liveJoinEnabled: false,
          consultationJoinEnabled: true,
        ),
      ),
    ));

    expect(find.text('This commercial room is not available yet.'), findsOneWidget);
    expect(find.text('Join live event'), findsNothing);
    expect(gateway.calls, 0);
  });

  test('consultation media choices are explicit and viewer remains receive-only', () {
    final plan = CommercialGetStreamMediaPlan(
      canPublish: true,
      cameraEnabled: false,
      microphoneEnabled: true,
    );
    expect(plan.cameraEnabled, isFalse);
    expect(plan.microphoneEnabled, isTrue);
    expect(CommercialGetStreamMediaPlan.forRole(CommercialGetStreamRole.viewer).canPublish, isFalse);
    expect(CommercialConsultationCompletionScreen, isNotNull);
  });
}
