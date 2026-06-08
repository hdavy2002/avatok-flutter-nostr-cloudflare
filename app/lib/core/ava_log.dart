import 'dart:async';

/// Lightweight in-app diagnostic log (ring buffer). Lets us see what the chat
/// transport is doing on a real device and copy it out from the Diagnostics
/// page in the sidebar. Cheap + safe to call from anywhere.
class AvaLog {
  AvaLog._();
  static final AvaLog I = AvaLog._();

  static const int _max = 800;
  final List<String> _lines = [];
  final _changes = StreamController<void>.broadcast();

  /// Emits whenever a line is added/cleared (so the Diagnostics page refreshes).
  Stream<void> get changes => _changes.stream;

  void log(String tag, String message) {
    final t = DateTime.now();
    final ts = '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}'
        ':${t.second.toString().padLeft(2, '0')}.${t.millisecond.toString().padLeft(3, '0')}';
    _lines.add('$ts  [$tag] $message');
    if (_lines.length > _max) _lines.removeRange(0, _lines.length - _max);
    if (!_changes.isClosed) _changes.add(null);
  }

  /// Newest-first dump for copying.
  String dump() => _lines.reversed.join('\n');

  int get length => _lines.length;

  void clear() {
    _lines.clear();
    if (!_changes.isClosed) _changes.add(null);
  }
}
