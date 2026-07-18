// One Brain B3 / §6.1 — NETWORKLESS proof for the device-private brain.
//
// "Networkless AvaLocalBrain is proven, not promised." — SPEC §6.1
//
// This test is the machine that keeps that promise. It walks the transitive
// import graph of every Dart file under `lib/core/local_brain/` and FAILS the
// build if the module can reach a network-capable dependency — `dart:io`
// HttpClient/Socket usage, `package:http`, `package:dio`, `web_socket_channel`,
// or any package not on the audited allowlist. A convention can rot; this test
// cannot. If someone re-introduces a second brain (the RagService mistake) by
// importing a network client into the device lane, CI goes red here.
//
// It ALSO guards (second group) against the specific regression B-D2 removed:
// no file anywhere under `lib/` may reference `RagService` or the Gemini/CF
// File Search ingest endpoints again — so the cut brain cannot quietly return.
//
// Pure Dart + dart:io file reads only — runs under `flutter test` / `dart test`
// with no device, no network, no build step.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  const moduleDir = 'lib/core/local_brain';

  // ── dart: core libraries the module MAY use (dart:io is NOT here) ────────────
  const allowedDartLibs = <String>{
    'core', 'async', 'convert', 'math', 'typed_data', 'collection',
    'developer', 'ffi', // ffi is CPU/native only, no sockets
  };

  // ── third-party packages the module MAY import (none network-capable) ────────
  const allowedPackages = <String>{
    'drift', 'sqlite3', 'sqlite3_flutter_libs', 'sqflite', 'sqflite_common',
    'path', 'path_provider', 'crypto', 'collection', 'meta', 'flutter',
    'flutter_test',
  };

  // ── packages that are an INSTANT fail (clear, explicit deny for good errors) ──
  const denyPackages = <String>{
    'http', 'http2', 'dio', 'web_socket_channel', 'socket_io_client',
    'grpc', 'googleapis', 'googleapis_auth', 'firebase_database',
    'cloud_firestore', 'graphql', 'graphql_flutter', 'cronet_http',
    'cupertino_http', 'fetch_client', 'universal_html', 'html',
  };

  // ── audited project files OUTSIDE the module that module files MAY import ─────
  // Each is a reviewed leaf: it is NOT recursed into, but it is pinned here so a
  // NEW external dependency (e.g. a future `../rag_service.dart` or
  // `../api_auth.dart`) trips this test and forces a review. Justifications:
  const allowedExternal = <String, String>{
    'lib/core/ava_log.dart':
        'diagnostics logger (re-exports ava_diagnostics); logs event names/counts, '
            'never device-index content — audited leaf, not a content channel',
    'lib/core/db.dart':
        'the per-account SQLite (drift) source of truth; local DB engine only',
  };

  // ── banned dart:io network identifiers (scanned in module file bodies) ───────
  final bannedApi = RegExp(
    r'\b('
    r'HttpClient|HttpServer|SecureServerSocket|SecureSocket|RawSecureSocket|'
    r'RawServerSocket|RawSocket|ServerSocket|Socket|RawDatagramSocket|'
    r'WebSocket|InternetAddress|NetworkInterface'
    r')\b',
  );

  // Extract import/export/part URIs from Dart source (comments stripped first).
  List<String> _uris(String src) {
    final noBlock = src.replaceAll(RegExp(r'/\*.*?\*/', dotAll: true), '');
    final noLine = noBlock.replaceAll(RegExp(r'//[^\n]*'), '');
    final re = RegExp(
      '''(?:import|export|part)\\s+['"]([^'"]+)['"]''',
    );
    return [for (final m in re.allMatches(noLine)) m.group(1)!];
  }

  // Resolve a relative URI against a file's directory → normalised repo path.
  String _resolveRelative(String fromFile, String uri) {
    final baseDir = File(fromFile).parent.path;
    final joined = '$baseDir/$uri';
    final parts = <String>[];
    for (final seg in joined.split('/')) {
      if (seg == '.' || seg.isEmpty) continue;
      if (seg == '..') {
        if (parts.isNotEmpty) parts.removeLast();
      } else {
        parts.add(seg);
      }
    }
    return parts.join('/');
  }

  // Map package:avatok_call/foo.dart → lib/foo.dart (self-package imports).
  String? _selfPackageToPath(String uri) {
    const prefix = 'package:avatok_call/';
    if (uri.startsWith(prefix)) return 'lib/${uri.substring(prefix.length)}';
    return null;
  }

  test('local_brain module has no network-capable dependency (§6.1)', () {
    final root = Directory(moduleDir);
    expect(root.existsSync(), isTrue,
        reason: 'device-brain module $moduleDir must exist');

    final seed = root
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))
        .map((f) => f.path)
        .toList();
    expect(seed, isNotEmpty, reason: 'no .dart files found under $moduleDir');

    final visited = <String>{};
    final queue = <String>[...seed];
    final violations = <String>[];

    bool _insideModule(String path) =>
        path == moduleDir || path.startsWith('$moduleDir/');

    while (queue.isNotEmpty) {
      final path = queue.removeLast();
      if (!visited.add(path)) continue;

      final file = File(path);
      if (!file.existsSync()) {
        violations.add('$path — import target does not exist');
        continue;
      }
      final src = file.readAsStringSync();

      // Body scan (module-internal files only — audited external leaves excluded).
      if (_insideModule(path)) {
        final noStrings = src.replaceAll(RegExp('''(['"]).*?\\1'''), '');
        final noComments = noStrings
            .replaceAll(RegExp(r'/\*.*?\*/', dotAll: true), '')
            .replaceAll(RegExp(r'//[^\n]*'), '');
        for (final m in bannedApi.allMatches(noComments)) {
          violations.add('$path — uses banned network API `${m.group(1)}`');
        }
      }

      for (final uri in _uris(src)) {
        if (uri.startsWith('dart:')) {
          final lib = uri.substring('dart:'.length).split('/').first;
          if (lib == 'io') {
            violations.add('$path — imports `dart:io` (grants sockets/HttpClient)');
          } else if (!allowedDartLibs.contains(lib)) {
            violations.add('$path — imports non-allowlisted `dart:$lib`');
          }
          continue;
        }

        if (uri.startsWith('package:')) {
          final selfPath = _selfPackageToPath(uri);
          if (selfPath != null) {
            _consider(selfPath, path, queue, visited, allowedExternal, violations,
                _insideModule);
            continue;
          }
          final pkg = uri.substring('package:'.length).split('/').first;
          if (denyPackages.contains(pkg)) {
            violations.add('$path — imports network package `package:$pkg`');
          } else if (!allowedPackages.contains(pkg)) {
            violations.add(
                '$path — imports non-allowlisted `package:$pkg` (add to the '
                'audited allowlist in this test only after confirming it cannot '
                'reach the network)');
          }
          continue;
        }

        // Relative / part URI → resolve to a repo path.
        final resolved = _resolveRelative(path, uri);
        _consider(resolved, path, queue, visited, allowedExternal, violations,
            _insideModule);
      }
    }

    expect(violations, isEmpty,
        reason: 'NETWORKLESS BOUNDARY VIOLATED (§6.1):\n  ${violations.join('\n  ')}');
  });

  test('the RagService second brain stays cut in CODE (B-D2 / §6.1)', () {
    // We scan CODE only (comments stripped): historical "…was CUT (B-D2)"
    // documentation is welcome and must not trip this; a live `RagService`
    // symbol or a File Search ingest endpoint STRING LITERAL must.
    final offenders = <String>[];
    const bannedNeedles = <String>[
      'RagService',
      '/api/ava/rag/ingest',
      '/api/ava/rag/backfill',
      '/api/ava/rag/store',
    ];
    for (final f in Directory('lib')
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))) {
      final code = f
          .readAsStringSync()
          .replaceAll(RegExp(r'/\*.*?\*/', dotAll: true), '')
          .replaceAll(RegExp(r'//[^\n]*'), '');
      for (final needle in bannedNeedles) {
        if (code.contains(needle)) {
          offenders.add('${f.path} — live reference to removed brain `$needle`');
        }
      }
    }
    expect(offenders, isEmpty,
        reason: 'RagService / File Search ingest brain must not return:\n  '
            '${offenders.join('\n  ')}');
  });
}

// Decide what to do with a resolved project-file dependency.
void _consider(
  String resolved,
  String from,
  List<String> queue,
  Set<String> visited,
  Map<String, String> allowedExternal,
  List<String> violations,
  bool Function(String) insideModule,
) {
  if (insideModule(resolved)) {
    if (!visited.contains(resolved)) queue.add(resolved); // recurse into module
  } else if (allowedExternal.containsKey(resolved)) {
    // Pinned, audited external leaf — allowed, not recursed into.
  } else {
    violations.add(
        '$from — imports un-audited external project file `$resolved` '
        '(a local_brain file may only import allowlisted packages, other '
        'local_brain files, or a pinned audited leaf)');
  }
}
