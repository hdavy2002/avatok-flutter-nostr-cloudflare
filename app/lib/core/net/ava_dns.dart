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
  // Google (/resolve) is FIRST: Jio (and several Indian carriers) block or
  // hijack Cloudflare's 1.1.1.1 / 1.0.0.1, which is exactly why the old
  // Cloudflare-first order timed out on Jio (doh_resolve_fail). Google 8.8.8.8
  // stays reachable there. Cloudflare kept as secondary for networks that block
  // Google instead.
  static const List<_Doh> _endpoints = [
    _Doh('8.8.8.8', '/resolve'),
    _Doh('1.1.1.1', '/dns-query'),
    _Doh('1.0.0.1', '/dns-query'),
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
          final v4 = res.addrs.where((a) => a.type == InternetAddressType.IPv4).length;
          Analytics.capture('doh_resolve_ok', {
            'host': host,
            'resolver': e.ip,
            'ms': DateTime.now().difference(t0).inMilliseconds,
            'n': res.addrs.length,
            'family': v4 > 0 ? (v4 == res.addrs.length ? 'v4' : 'dual') : 'v6',
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

  /// One DoH JSON query — asks for BOTH A (IPv4) and AAAA (IPv6) so v6-only /
  /// NAT64 carriers (Jio) get a usable answer. IPv4 is listed first (preferred),
  /// IPv6 appended. Returns the addresses + the min record TTL, or null.
  Future<_DohResult?> _queryDoh(_Doh e, String host) async {
    final v4 = await _queryDohType(e, host, 'A', 1);
    final v6 = await _queryDohType(e, host, 'AAAA', 28);
    final ips = <InternetAddress>[...?v4?.addrs, ...?v6?.addrs];
    if (ips.isEmpty) return null;
    final ttl = [v4?.ttl ?? 300, v6?.ttl ?? 300].reduce((a, b) => a < b ? a : b);
    return _DohResult(ips, ttl);
  }

  /// One DoH JSON query for a single record [type] ('A' → dnsType 1,
  /// 'AAAA' → 28). Returns matching addresses + min TTL, or null.
  Future<_DohResult?> _queryDohType(_Doh e, String host, String type, int dnsType) async {
    final uri = Uri.parse(
        'https://${e.ip}${e.path}?name=${Uri.encodeComponent(host)}&type=$type');
    final req = await _doh.getUrl(uri).timeout(const Duration(seconds: 3));
    req.headers.set(HttpHeaders.acceptHeader, 'application/dns-json');
    final resp = await req.close().timeout(const Duration(seconds: 3));
    if (resp.statusCode != 200) return null;
    final body = await resp.transform(utf8.decoder).join();
    final json = jsonDecode(body) as Map<String, dynamic>;
    final answers = (json['Answer'] as List?) ?? const [];
    final ips = <InternetAddress>[];
    var minTtl = 300;
    for (final a in answers) {
      // CNAME (5) answers are followed server-side already; we keep the terminal
      // A (1) / AAAA (28) records.
      if (a is Map && a['type'] == dnsType) {
        final ip = InternetAddress.tryParse('${a['data']}');
        if (ip != null) ips.add(ip);
        final ttl = (a['TTL'] as num?)?.toInt() ?? 300;
        if (ttl < minTtl) minTtl = ttl;
      }
    }
    return ips.isEmpty ? null : _DohResult(ips, minTtl);
  }

  /// Fire-and-forget DNS health probe for [host]: times the OS resolver, then
  /// (on OS failure) tries DoH, and emits a `dns_probe` telemetry event. Called
  /// by the HTTP wrapper on a transport failure so "Failed host lookup" on a
  /// carrier is queryable per host/network instead of being invisible. Never
  /// throws.
  Future<void> probe(String host) async {
    if (InternetAddress.tryParse(host) != null) return; // IP literal — nothing to probe
    final t0 = DateTime.now();
    try {
      final r =
          await InternetAddress.lookup(host).timeout(const Duration(seconds: 3));
      final v4 = r.where((a) => a.type == InternetAddressType.IPv4).length;
      await Analytics.dnsProbe(
        host: host,
        osOk: r.isNotEmpty,
        osMs: DateTime.now().difference(t0).inMilliseconds,
        family: r.isEmpty ? null : (v4 > 0 ? (v4 == r.length ? 'v4' : 'dual') : 'v6'),
      );
      return;
    } catch (osErr) {
      // OS resolution failed — try DoH so we know whether the name is resolvable
      // at all from this network (carrier DNS broken) or genuinely unreachable.
      if (!dohEnabled) {
        await Analytics.dnsProbe(
            host: host, osOk: false,
            osMs: DateTime.now().difference(t0).inMilliseconds,
            error: osErr.toString());
        return;
      }
      final d0 = DateTime.now();
      for (final e in _endpoints) {
        try {
          final res = await _queryDoh(e, host);
          if (res != null && res.addrs.isNotEmpty) {
            final v4 = res.addrs.where((a) => a.type == InternetAddressType.IPv4).length;
            await Analytics.dnsProbe(
              host: host, osOk: false,
              osMs: DateTime.now().difference(t0).inMilliseconds,
              dohOk: true, dohResolver: e.ip,
              dohMs: DateTime.now().difference(d0).inMilliseconds,
              family: v4 > 0 ? (v4 == res.addrs.length ? 'v4' : 'dual') : 'v6',
              error: osErr.toString());
            return;
          }
        } catch (_) {/* try next resolver */}
      }
      await Analytics.dnsProbe(
          host: host, osOk: false,
          osMs: DateTime.now().difference(t0).inMilliseconds,
          dohOk: false,
          dohMs: DateTime.now().difference(d0).inMilliseconds,
          error: osErr.toString());
    }
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

/// PERF-DNS-4 (2026-07-04) — DISABLED: do NOT install the connectionFactory
/// override. Field-proven root cause of a total sign-in/API outage: routing
/// dart:io connections through a resolved TCP IP made Cloudflare's shared edge
/// answer **400 Bad Request** before the Worker (SNI/routing broke on the
/// IP-connect path). On carriers with flaky DNS (Jio) the OS lookup fails and
/// the code was forced onto that broken IP path → hard 400 for Google + email
/// sign-in AND every /api/* call, on every network. Reverting to pure default
/// networking restores the known-good behaviour (the 50b4d86 build that signed
/// in fine). The [AvaDns] DoH resolver is kept for a future, device-TESTED
/// re-enable (must verify TLS SNI end-to-end against Cloudflare before shipping).
void installAvaDns() {
  // Intentionally a no-op — see PERF-DNS-4 note above. Pure OS DNS + default
  // dart:io connection (identical to the last known-good build).
  //
  // DELIBERATELY NO `HttpOverrides.global` / custom `connectionFactory` here.
  // A dart:io `connectionFactory` severs TLS SNI on the secure upgrade, so
  // Cloudflare's shared edge answers 400 before the Worker — a total sign-in
  // outage (field-proven 2026-07-04, builds 04ec3d3 / fda87cd). Do NOT add one
  // back to "route DNS": use [AvaDns.resolve] / [AvaDns.probe] for observation
  // only. Any IP-level connection routing must be validated end-to-end against
  // Cloudflare (SNI intact) on a real device first.
}
