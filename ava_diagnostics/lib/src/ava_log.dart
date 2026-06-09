import 'dart:async';
import 'dart:math';

/// One diagnostic line. Metadata only — NEVER message content / PII.
class AvaLogEntry {
  final int ts; // epoch ms
  final String level; // info | warn | error
  final String tag; // relay | dm | call | push | id | app …
  final String line;
  AvaLogEntry(this.ts, this.level, this.tag, this.line);
}

/// In-app diagnostic log (ring buffer) shown on a Diagnostics page, plus a
/// [sink] that forwards every line elsewhere — wire it to PostHog so logs stream
/// live to the backend automatically, keyed by the user's npub. No manual
/// upload, no app-owned DB. Shared across every AvaVerse app — set [app] to the
/// app key so all apps' logs are distinguishable in one stream.
class AvaLog {
  AvaLog._();
  static final AvaLog I = AvaLog._();

  static const int _max = 1500;
  final List<AvaLogEntry> _entries = [];
  final _changes = StreamController<void>.broadcast();

  /// App key (each app sets its own, e.g. 'avatok', 'avachat', 'avalive').
  String app = 'avatok';

  /// Per app-launch id so a single run can be correlated in PostHog.
  final String session = _genSession();

  /// Forwards each line to live telemetry (PostHog). Set once at startup.
  void Function(AvaLogEntry entry)? sink;

  Stream<void> get changes => _changes.stream;

  void log(String tag, String message, {String level = 'info'}) {
    final e = AvaLogEntry(DateTime.now().millisecondsSinceEpoch, level, tag, message);
    _entries.add(e);
    if (_entries.length > _max) _entries.removeRange(0, _entries.length - _max);
    try {
      sink?.call(e);
    } catch (_) {/* telemetry must never break logging */}
    if (!_changes.isClosed) _changes.add(null);
  }

  void warn(String tag, String message) => log(tag, message, level: 'warn');
  void error(String tag, String message) => log(tag, message, level: 'error');

  int get length => _entries.length;

  /// Newest-first plain text for a Diagnostics page / clipboard.
  String dump() => _entries.reversed.map(_fmt).join('\n');

  String _fmt(AvaLogEntry e) {
    final t = DateTime.fromMillisecondsSinceEpoch(e.ts);
    String two(int n) => n.toString().padLeft(2, '0');
    final ms = e.ts.remainder(1000).toString().padLeft(3, '0');
    final lvl = e.level == 'info' ? '' : '${e.level.toUpperCase()} ';
    return '${two(t.hour)}:${two(t.minute)}:${two(t.second)}.$ms  $lvl[${e.tag}] ${e.line}';
  }

  void clear() {
    _entries.clear();
    if (!_changes.isClosed) _changes.add(null);
  }

  static String _genSession() {
    final r = Random();
    const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return List.generate(8, (_) => c[r.nextInt(c.length)]).join();
  }
}
