// Phase 5 — shared AvaCalendar/AvaBooking data layer. Local-first: the last
// fetched blocks/bookings are cached per-account via DiskCache (rulebook §1 —
// DiskCache already namespaces by AccountScope.id), so the month grid renders
// offline; a network refresh follows.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/disk_cache.dart';
import '../../core/platform_api.dart';

/// source_app → blip styling (one color per app, used by both screens).
class SourceStyle {
  final String label;
  final Color color;
  final IconData icon;
  const SourceStyle(this.label, this.color, this.icon);
}

// [UI-ICONS-1 2026-08-05] Material glyphs → Phosphor. `PhosphorIcons.x(...)` is
// a FUNCTION CALL, so this map can no longer be `const`; it is `final` instead.
// Both consumers (`avacalendar_screen._legend`, `booking_card`) read it at
// runtime, so nothing downstream needed to change.
final kSourceStyles = <String, SourceStyle>{
  'avacalendar': SourceStyle('AvaCalendar', const Color(0xFFEAB308),
      PhosphorIcons.calendarBlank(PhosphorIconsStyle.regular)),
  'avabooking': SourceStyle('AvaBooking', const Color(0xFFE1306C),
      PhosphorIcons.calendarCheck(PhosphorIconsStyle.regular)),
  'avalive': SourceStyle('AvaLive', const Color(0xFFFF3B30),
      PhosphorIcons.broadcast(PhosphorIconsStyle.regular)),
  'avaconsult': SourceStyle('AvaConsult', const Color(0xFF22C9C0),
      PhosphorIcons.videoCamera(PhosphorIconsStyle.regular)),
  'gcal': SourceStyle('Google Calendar', const Color(0xFF4285F4),
      PhosphorIcons.calendarDots(PhosphorIconsStyle.regular)),
  'manual': SourceStyle('Manual block', const Color(0xFF737A86),
      PhosphorIcons.prohibit(PhosphorIconsStyle.regular)),
};

SourceStyle styleFor(String? sourceApp) =>
    kSourceStyles[sourceApp] ??
    SourceStyle('Busy', const Color(0xFF737A86),
        PhosphorIcons.calendarX(PhosphorIconsStyle.regular));

class CalBlock {
  final String id;
  final String sourceApp;
  final String? sourceRef;
  final int startsAt;
  final int endsAt;
  final String? title;
  CalBlock(this.id, this.sourceApp, this.sourceRef, this.startsAt, this.endsAt, this.title);

  factory CalBlock.fromJson(Map<String, dynamic> j) => CalBlock(
        j['id'] as String? ?? '',
        j['source_app'] as String? ?? 'manual',
        j['source_ref'] as String?,
        (j['starts_at'] as num?)?.toInt() ?? 0,
        (j['ends_at'] as num?)?.toInt() ?? 0,
        j['title'] as String?,
      );
  Map<String, dynamic> toJson() => {
        'id': id, 'source_app': sourceApp, 'source_ref': sourceRef,
        'starts_at': startsAt, 'ends_at': endsAt, 'title': title,
      };
}

/// Local-first blocks store: cached render first, then network refresh.
class CalendarStore {
  static const _cacheName = 'avacalendar_blocks_v1';

  static Future<List<CalBlock>> cached() async {
    try {
      final raw = await DiskCache.read(_cacheName);
      if (raw == null) return const [];
      return (jsonDecode(raw) as List)
          .map((e) => CalBlock.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
    } catch (_) {
      return const [];
    }
  }

  /// Fetch [from,to) from the API and refresh the cache.
  static Future<List<CalBlock>> refresh({required int from, required int to}) async {
    final rows = await PlatformApi.calendarBlocks(from: from, to: to);
    final blocks = rows.map(CalBlock.fromJson).toList();
    try {
      await DiskCache.write(_cacheName, jsonEncode(blocks.map((b) => b.toJson()).toList()));
    } catch (_) {/* cache is best-effort */}
    return blocks;
  }
}

/// A2: cross-tz rendering — "10:00 (your time) · 14:00 UTC". The server keys
/// everything in UTC epoch ms; the device renders local + UTC so two parties
/// in different zones never misread a booking time.
String fmtTimeBoth(int epochMs) {
  final local = DateTime.fromMillisecondsSinceEpoch(epochMs);
  final utc = local.toUtc();
  String hm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  return '${hm(local)} (your time) · ${hm(utc)} UTC';
}

String fmtDate(int epochMs) {
  final d = DateTime.fromMillisecondsSinceEpoch(epochMs);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${d.day} ${months[d.month - 1]} ${d.year}';
}

String fmtRange(int startMs, int endMs) {
  String hm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  final s = DateTime.fromMillisecondsSinceEpoch(startMs);
  final e = DateTime.fromMillisecondsSinceEpoch(endMs);
  return '${hm(s)}–${hm(e)}';
}
