import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/ui/avatok_dark.dart';

/// Live-location shared state for ONE live-share bubble (WhatsApp-style).
///
/// One [LiveLocationSession] is created per `t:'live'` message — keyed by the
/// share `id`. The sender's [LiveLocationBroadcaster] (core/live_location_service.dart)
/// pushes high-frequency GPS ticks over the ephemeral presence WS; the receiver's
/// chat thread applies them via [apply]. The inline map preview and the expanded
/// [LiveMapScreen] both listen to this notifier so the pin moves live with zero
/// rebuilds of the surrounding message list.
class LiveLocationSession extends ChangeNotifier {
  final String id;
  final bool mine; // true = I am the one broadcasting
  String name;
  double lat;
  double lng;
  int until; // epoch seconds when sharing auto-stops
  double? heading; // degrees, 0..360 (course over ground)
  double? speed; // m/s
  int lastTs; // epoch seconds of the freshest fix we've applied
  bool ended = false;

  LiveLocationSession({
    required this.id,
    required this.lat,
    required this.lng,
    required this.until,
    required this.mine,
    required this.name,
    this.heading,
    this.speed,
    this.lastTs = 0,
  });

  int get _now => DateTime.now().millisecondsSinceEpoch ~/ 1000;

  /// Still actively sharing (not manually stopped and not past its window).
  bool get isActive => !ended && _now < until;

  Duration get remaining =>
      Duration(seconds: (until - _now).clamp(0, 12 * 3600));

  /// Apply a newer fix. Ignores out-of-order / stale ticks.
  void apply(double newLat, double newLng, int ts,
      {double? heading, double? speed, int? until}) {
    if (ts < lastTs) return;
    lat = newLat;
    lng = newLng;
    lastTs = ts;
    if (heading != null) this.heading = heading;
    if (speed != null) this.speed = speed;
    if (until != null) this.until = until;
    notifyListeners();
  }

  void end() {
    if (ended) return;
    ended = true;
    notifyListeners();
  }

  /// "ends in 12 min" / "ends in 1 h 04 m" / "ended".
  String statusLabel() {
    if (!isActive) return 'Live location ended';
    final r = remaining;
    if (r.inMinutes < 60) return 'Live · ends in ${r.inMinutes} min';
    final h = r.inHours;
    final m = r.inMinutes % 60;
    return 'Live · ends in $h h ${m.toString().padLeft(2, '0')} m';
  }
}

/// A dependency-free slippy-map view: OpenStreetMap raster tiles laid out on a
/// Flutter [Stack] and centered on ([lat], [lng]), with a pin at the center.
///
/// Deliberately uses no native map SDK and no API key so it can't break the
/// headless CI APK build. Tiles are fetched with the framework's [Image.network]
/// (HTTP cache + gapless playback), so as the session pushes new coordinates the
/// map simply re-lays the tiles and the pin tracks the mover.
///
/// NOTE: for production scale, swap the tile URL for your own styled tile/Static
/// Maps endpoint (Google/Mapbox/own raster proxy) with a key — OSM's public tile
/// server is rate-limited and intended for light use.
class LiveMapView extends StatelessWidget {
  final double lat;
  final double lng;
  final int zoom;
  final double width;
  final double height;
  final bool showPin;
  final Color pinColor;
  final double radius;

  const LiveMapView({
    super.key,
    required this.lat,
    required this.lng,
    required this.width,
    required this.height,
    this.zoom = 15,
    this.showPin = true,
    this.pinColor = AD.danger,
    this.radius = 12,
  });

  static const double _tile = 256;

  @override
  Widget build(BuildContext context) {
    final n = math.pow(2.0, zoom).toDouble();
    final maxIndex = n.toInt();
    final latRad = lat * math.pi / 180;
    // Web-Mercator fractional tile coords for the center point.
    final xTile = (lng + 180.0) / 360.0 * n;
    final yTile =
        (1 - (math.log(math.tan(latRad) + 1 / math.cos(latRad)) / math.pi)) /
            2 *
            n;
    final centerPxX = xTile * _tile;
    final centerPxY = yTile * _tile;
    // Global-pixel coords of the viewport's top-left corner.
    final topLeftX = centerPxX - width / 2;
    final topLeftY = centerPxY - height / 2;

    final minTileX = (topLeftX / _tile).floor();
    final maxTileX = ((topLeftX + width) / _tile).floor();
    final minTileY = (topLeftY / _tile).floor();
    final maxTileY = ((topLeftY + height) / _tile).floor();

    final tiles = <Widget>[];
    for (var tx = minTileX; tx <= maxTileX; tx++) {
      for (var ty = minTileY; ty <= maxTileY; ty++) {
        if (ty < 0 || ty >= maxIndex) continue; // no vertical wrap
        final wrappedX = ((tx % maxIndex) + maxIndex) % maxIndex; // wrap X
        final left = tx * _tile - topLeftX;
        final top = ty * _tile - topLeftY;
        tiles.add(Positioned(
          left: left,
          top: top,
          width: _tile,
          height: _tile,
          child: Image.network(
            'https://tile.openstreetmap.org/$zoom/$wrappedX/$ty.png',
            fit: BoxFit.cover,
            gaplessPlayback: true,
            errorBuilder: (_, __, ___) =>
                Container(color: const Color(0xFFE8E6DF)),
            loadingBuilder: (c, child, progress) =>
                progress == null ? child : Container(color: const Color(0xFFE8E6DF)),
          ),
        ));
      }
    }

    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: Container(
        width: width,
        height: height,
        decoration: BoxDecoration(
          border: Border.all(color: AD.borderControl, width: 1),
          borderRadius: BorderRadius.circular(radius),
        ),
        child: Stack(
          clipBehavior: Clip.hardEdge,
          children: [
            ...tiles,
            if (showPin)
              Positioned(
                left: width / 2 - 17,
                top: height / 2 - 34,
                child: _MapPin(color: pinColor),
              ),
          ],
        ),
      ),
    );
  }
}

class _MapPin extends StatelessWidget {
  final Color color;
  const _MapPin({required this.color});

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        PhosphorIcon(PhosphorIcons.mapPin(PhosphorIconsStyle.fill),
            color: color, size: 34),
        Container(
          width: 6,
          height: 3,
          decoration: BoxDecoration(
            color: Colors.black.withOpacity(0.25),
            borderRadius: BorderRadius.circular(3),
          ),
        ),
      ],
    );
  }
}

/// Full-screen expanded live view. Auto-follows the sender's marker as ticks
/// arrive, shows a live countdown, an "Open in Google Maps" deep link, and (for
/// the sender) a "Stop sharing" button.
class LiveMapScreen extends StatelessWidget {
  final LiveLocationSession session;
  final String title;
  final VoidCallback? onStop; // non-null only when this is MY share
  final void Function(String event)? onTelemetry;

  const LiveMapScreen({
    super.key,
    required this.session,
    required this.title,
    this.onStop,
    this.onTelemetry,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        elevation: 0,
        title: Text(title, style: ADText.threadName()),
      ),
      body: AnimatedBuilder(
        animation: session,
        builder: (context, _) {
          return Column(
            children: [
              Expanded(
                child: LayoutBuilder(
                  builder: (context, c) => Stack(
                    children: [
                      LiveMapView(
                        lat: session.lat,
                        lng: session.lng,
                        width: c.maxWidth,
                        height: c.maxHeight,
                        zoom: 16,
                        radius: 0,
                      ),
                      Positioned(
                        left: 12,
                        bottom: 8,
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 2),
                          color: Colors.white.withOpacity(0.7),
                          child: const Text('© OpenStreetMap',
                              style: TextStyle(fontSize: 9, color: Colors.black54)),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(children: [
                        _LiveDot(active: session.isActive),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(session.statusLabel(),
                              style: ADText.rowName()),
                        ),
                        if (session.speed != null && session.isActive)
                          Text('${(session.speed! * 3.6).toStringAsFixed(0)} km/h',
                              style: ADText.statCaption(c: AD.textSecondary)),
                      ]),
                      const SizedBox(height: 12),
                      Row(children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: () {
                              onTelemetry?.call('live_location_open_in_maps');
                              launchUrl(
                                Uri.parse(
                                    'https://maps.google.com/?q=${session.lat},${session.lng}'),
                                mode: LaunchMode.externalApplication,
                              );
                            },
                            icon: const Icon(Icons.map, size: 16),
                            label: const Text('Open in Google Maps'),
                          ),
                        ),
                        if (onStop != null && session.isActive) ...[
                          const SizedBox(width: 10),
                          Expanded(
                            child: FilledButton.icon(
                              style: FilledButton.styleFrom(
                                  backgroundColor: AD.destructiveBg),
                              onPressed: () {
                                onStop!.call();
                                Navigator.maybePop(context);
                              },
                              icon: PhosphorIcon(
                                  PhosphorIcons.stopCircle(
                                      PhosphorIconsStyle.fill),
                                  size: 16,
                                  color: Colors.white),
                              label: const Text('Stop sharing',
                                  style: TextStyle(color: Colors.white)),
                            ),
                          ),
                        ],
                      ]),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _LiveDot extends StatefulWidget {
  final bool active;
  const _LiveDot({required this.active});
  @override
  State<_LiveDot> createState() => _LiveDotState();
}

class _LiveDotState extends State<_LiveDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 900))
        ..repeat(reverse: true);
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.active) {
      return Icon(Icons.circle, size: 11, color: AD.textSecondary);
    }
    return FadeTransition(
      opacity: Tween(begin: 0.35, end: 1.0).animate(_c),
      child: const Icon(Icons.circle, size: 11, color: AD.online),
    );
  }
}
