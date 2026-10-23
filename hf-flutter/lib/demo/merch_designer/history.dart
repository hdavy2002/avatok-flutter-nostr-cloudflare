import 'contract.dart';

/// [HF-MERCH-STUDIO-2] Undo / redo over deep-copied layer lists. Changes with the same `key` made close together
/// (slider drags, typing) merge into one step.
class LayerHistory {
  LayerHistory(List<DesignLayer> first, {this.limit = 80, this.windowMs = 900}) : _stack = <List<DesignLayer>>[_clone(first)];

  final int limit;
  final int windowMs;
  final List<List<DesignLayer>> _stack;
  int _i = 0;
  String? _key;
  int _at = 0;

  static List<DesignLayer> _clone(List<DesignLayer> l) => <DesignLayer>[for (final x in l) x.copy()];

  bool get canUndo => _i > 0;
  bool get canRedo => _i < _stack.length - 1;

  /// Records the layers as they are now.
  void push(List<DesignLayer> layers, {String? key}) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final snap = _clone(layers);
    if (_i < _stack.length - 1) _stack.removeRange(_i + 1, _stack.length);
    final merge = key != null && key == _key && now - _at < windowMs && _i > 0;
    if (merge) {
      _stack[_i] = snap;
    } else {
      _stack.add(snap);
      _i = _stack.length - 1;
      if (_stack.length > limit) {
        _stack.removeAt(0);
        _i--;
      }
    }
    _key = key;
    _at = now;
  }

  /// A fresh copy of the previous state, or null.
  List<DesignLayer>? undo() {
    if (!canUndo) return null;
    _i--;
    _key = null;
    return _clone(_stack[_i]);
  }

  List<DesignLayer>? redo() {
    if (!canRedo) return null;
    _i++;
    _key = null;
    return _clone(_stack[_i]);
  }
}
