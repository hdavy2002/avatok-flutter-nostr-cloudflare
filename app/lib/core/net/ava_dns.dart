import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../analytics.dart';
import '../ava_log.dart';

/// Carrier-proof DNS. The device's own resolver is intermittently unable to
/// resolve our hostnames (first observed on Jio in India: "Failed host lookup:
/// clerk.avatok.ai / api.avatok.ai") — but that failure mode exists on countless
/// mobile carriers worldwide, so we stop chasing individual networks and fix it
/// once, for everyone.
///
/// Strategy is **system-first, DoH-fallback**:
///   1. Try the OS resolver (identical to default behaviour → zero overhead and
///      zero behaviour change when the network is healthy).
///   2. On failure/timeout, fall back to DNS-over-HTTPS against Cloudflare
///      (1.1.1.1 / 1.0.0.1) then Google (8.8.8.8). These are IP literals, so
///      there is NO chicken-and-egg bootstrap — we connect straight to the IP
///      and TLS-validate the resolver's public cert (Cloudflare/Google both
///      carry the resolver IP in the cert's SAN list).
///
/// Results are cached with the record TTL (clamped) and IPv4 is preferred (many
/// broken-DNS carriers are IPv6/NAT64 setups). Installed process-wide via
/// [installAvaDns] / [AvaHttpOverrides] so EVERY dart:io HttpClient — package:http,
/// the Clerk client, the InboxDO + party WebSockets — is covered with no
/// call-site changes, while TLS SNI + certificate validation still use the
/// ORIGINAL hostname (only the TCP target IP is swapped).
class AvaDns {
  AvaDns._();
  static final AvaDns I = AvaDns._();

  /// Runtime kill switch (mirrors RemoteConfig.dohFallbackEnabled). When false,
  /// resolution is pure OS lookup — a misbehaving build can be neutralised from
  /// KV without a redeploy. Default ON so it works before the first config fetch
  /// (which itself then benefits from the fallback).
  static bool dohEnabled = true;

  final Map<String, _Entry> _cache = {};

  // A client for the DoH requests themselves. It is created lazily; because our
  // resolver short-circuits IP literals (below), a DoH request to 1.1.1.1 never
  // recurses back into DoH even when this client carries the global override.
  final HttpClient _doh = HttpClient()
    ..connectionTimeout = const Duration(seconds: 4);

  // DoH endpoints, tried in order. All are IP literals → no bootstrap DNS.
  // Cloudflare uses /dns-query (+accept header); Google uses /resolve.
  static const List<_Doh> _endpoints = [
    _Doh('1.1.1.1', '/dns-query'),
    _Doh('1.0.0.1', '/dns-query'),
    _Doh('8.8.8.8', '/resolve'),
  ];

  /// Resolve [host] to a connectable IP. Returns null only when BOTH the OS and
  /// every DoH endpoint fail — the caller then connects by hostname (last-ditch
  /// OS attempt) so behaviour is never worse than today.
  Future<InternetAddress?> resolve(String host) async {
    // Already an IP literal (incl. our own DoH endpoints) → nothing to resolve.
    final literal = InternetAddress.tryParse(host);
    if (literal != null) return literal;

    final cached = _cache[host];
    if (cached != null && !cached.expired) return cached.pick();

    // 1) OS resolver first — fast + free when the network is healthy.
    try {
      final r = await InternetAddress.lookup(host)
          .timeout(const Duration(seconds: 3));
      final v4 = r.where((a) => a.type == InternetAddressType.IPv4).toList();
      final addrs = v4.isNotEmpty ? v4 : r; // prefer IPv4, keep v6 for v6-only nets
      if (addrs.isNotEmpty) {
        _cache[host] = _Entry(addrs, DateTime.now().add(const Duration(seconds: 60)));
        return addrs.first;
      }
    } catch (_) {/* OS DNS failed/timed out — fall through to DoH */}

    if (!dohEnabled) return null;

    // 2) DoH fallback.
    final t0 = DateTime.now();
    for (final e in _endpoints) {
      try {
        final res = await _queryDoh(e, host);
        if (res != null && res.addrs.isNotEmpty) {
          _cache[host] = _Entry(
              res.addrs, DateTime.now().add(Duration(seconds: res.ttl.clamp(30, 300))));
          Analytics.capture('doh_resolve_ok', {
            'host': host,
            'resolver': e.ip,
            'ms': DateTime.now().difference(t0).inMilliseconds,
            'n': res.addrs.length,
          });
          return res.addrs.first;
        }
      } catch (err) {
        AvaLog.I.log('dns', 'DoH ${e.ip} failed for $host: $err');
      }
    }
    Analytics.capture('doh_resolve_fail',
        {'host': host, 'ms': DateTime.now().difference(t0).inMilliseconds});
    return null;
  }

  /// One DoH JSON query. Returns IPv4 addresses + the min record TTL, or null.
  Future<_DohResult?> _queryDoh(_Doh e, String host) async {
    final uri = Uri.parse(
        'https://${e.ip}${e.path}?name=${Uri.encodeComponent(host)}&type=A');
    final req = await _doh.getUrl(uri).timeout(const Duration(seconds: 4));
    req.headers.set(HttpHeaders.acceptHeader, 'application/dns-json');
    final resp = await req.close().timeout(const Duration(seconds: 4));
    if (resp.statusCode != 200) return null;
    final body = await resp.transform(utf8.decoder).join();
    final json = jsonDecode(body) as Map<String, dynamic>;
    final answers = (json['Answer'] as List?) ?? const [];
    final ips = <InternetAddress>[];
    var minTtl = 300;
    for (final a in answers) {
      if (a is Map && a['type'] == 1) {
        // type 1 = A record. CNAME (5) answers are followed server-side already.
        final ip = InternetAddress.tryParse('${a['data']}');
        if (ip != null) ips.add(ip);
        final ttl = (a['TTL'] as num?)?.toInt() ?? 300;
        if (ttl < minTtl) minTtl = ttl;
      }
    }
    return ips.isEmpty ? null : _DohResult(ips, minTtl);
  }
}

class _Doh {
  final String ip;
  final String path;
  const _Doh(this.ip, this.path);
}

class _DohResult {
  final List<InternetAddress> addrs;
  final int ttl;
  _DohResult(this.addrs, this.ttl);
}

class _Entry {
  final List<InternetAddress> addrs;
  final DateTime expiry;
  int _rr = 0;
  _Entry(this.addrs, this.expiry);
  bool get expired => DateTime.now().isAfter(expiry);
  // Simple round-robin so repeated connects spread across a host's IPs.
  InternetAddress pick() => addrs[(_rr++) % addrs.length];
}

/// Process-wide install: routes every dart:io HttpClient (package:http, the
/// Clerk client, WebSockets) through [AvaDns] while preserving TLS SNI +
/// certificate validation against the ORIGINAL hostname — we only swap the TCP
/// target IP. Call ONCE, early in main().
void installAvaDns() {
  HttpOverrides.global = AvaHttpOverrides();
}

class AvaHttpOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final client = super.createHttpClient(context);
    client.connectionFactory =
        (Uri url, String? proxyHost, int? proxyPort) async {
      final secure = url.scheme == 'https' || url.scheme == 'wss';
      final port = url.port != 0 ? url.port : (secure ? 443 : 80);
      // Honour an explicit proxy untouched.
      if (proxyHost != null) {
        return Socket.startConnect(proxyHost, proxyPort ?? port);
      }
      final ip = await AvaDns.I.resolve(url.host);
      // ip==null → let startConnect do a last-ditch OS lookup by hostname, so we
      // are never worse than the default resolver.
      return Socket.startConnect(ip ?? url.host, port);
    };
    return client;
  }
}
