import 'dart:async';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'cloudflare_conference_api.dart';
import 'cloudflare_conference_controller.dart';

enum ConferenceMigrationPhase { idle, reserved, preparing, sfuReady, committed, aborted }

/// Make-before-break coordinator for Waves 10–15. It never rings a new
/// participant and never tears down the existing P2P source until the server
/// has committed the migration. The capture stream belongs to the call session;
/// the conference controller is only a transport consumer.
class ConferenceMigrationCoordinator {
  final String roomId;
  final String groupId;
  final String callEpoch;
  final MediaStream sharedLocalStream;
  final CloudflareConferenceController Function(MediaStream stream) controllerFactory;

  ConferenceMigrationPhase phase = ConferenceMigrationPhase.idle;
  String? migrationId;
  CloudflareConferenceController? conference;

  ConferenceMigrationCoordinator({
    required this.roomId,
    required this.groupId,
    required this.callEpoch,
    required this.sharedLocalStream,
    required this.controllerFactory,
  });

  Future<bool> prepare() async {
    if (phase != ConferenceMigrationPhase.idle) return false;
    try {
      final reservation = await ConferenceRoomApi.reserveMigration(roomId, callEpoch: callEpoch);
      migrationId = reservation['migration_id']?.toString();
      if (migrationId == null) return _abort();
      phase = ConferenceMigrationPhase.reserved;
      await ConferenceRoomApi.prepareMigration(roomId, migrationId: migrationId!, callEpoch: callEpoch);
      phase = ConferenceMigrationPhase.preparing;

      final c = controllerFactory(sharedLocalStream);
      conference = c;
      await c.connect();
      if (c.state != CfConnState.connected || !c.hasMediaEvidence) return _abort();
      phase = ConferenceMigrationPhase.sfuReady;
      await ConferenceRoomApi.commitMigration(roomId, migrationId: migrationId!, sfuReady: true);
      phase = ConferenceMigrationPhase.committed;
      return true;
    } catch (_) {
      await _abort();
      return false;
    }
  }

  Future<bool> _abort() async {
    phase = ConferenceMigrationPhase.aborted;
    final id = migrationId;
    if (id != null) await ConferenceRoomApi.abortMigration(roomId, migrationId: id).catchError((_) => <String, dynamic>{});
    await conference?.leave();
    return false;
  }
}
