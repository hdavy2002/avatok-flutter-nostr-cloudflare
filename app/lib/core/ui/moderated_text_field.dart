// moderated_text_field.dart — a TextField wrapper that validates its content
// with the AI moderation endpoint (debounced) and reports validity so a parent
// can disable its Save button + show an inline reason.
//
// Usage:
//   ModeratedTextField(
//     controller: _bio,
//     fieldType: ModField.bio,
//     label: 'Bio',
//     onValidity: (ok) => setState(() => _bioOk = ok),
//   )
// The parent gates Save on its own `_bioOk && _nameOk && …` flags.
//
// Behavior: empty text is treated as valid (let required-field validation handle
// emptiness). While a check is in flight the field is considered NOT-yet-valid so
// Save stays disabled until a clean verdict returns. Fails OPEN on network error.
import 'dart:async';
import 'package:flutter/material.dart';
import '../moderation_service.dart';

class ModeratedTextField extends StatefulWidget {
  const ModeratedTextField({
    super.key,
    required this.controller,
    required this.fieldType,
    this.label,
    this.hint,
    this.maxLines = 1,
    this.maxLength,
    this.onValidity,
    this.debounce = const Duration(milliseconds: 700),
    this.decoration,
  });

  final TextEditingController controller;
  final String fieldType;
  final String? label;
  final String? hint;
  final int maxLines;
  final int? maxLength;
  /// Called whenever validity changes: true = safe (Save may enable).
  final ValueChanged<bool>? onValidity;
  final Duration debounce;
  final InputDecoration? decoration;

  @override
  State<ModeratedTextField> createState() => _ModeratedTextFieldState();
}

class _ModeratedTextFieldState extends State<ModeratedTextField> {
  Timer? _timer;
  bool _checking = false;
  String? _error;       // inline reason shown under the field when blocked
  String _lastChecked = '';

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onChanged);
  }

  @override
  void dispose() {
    _timer?.cancel();
    widget.controller.removeListener(_onChanged);
    super.dispose();
  }

  void _onChanged() {
    final text = widget.controller.text.trim();
    _timer?.cancel();
    if (text.isEmpty) {
      _setState(error: null, checking: false);
      widget.onValidity?.call(true); // empty handled by required-field logic
      _lastChecked = '';
      return;
    }
    if (text == _lastChecked && _error == null) return; // already cleared
    // Pending check ⇒ not valid yet (keep Save disabled until verdict returns).
    widget.onValidity?.call(false);
    _setState(checking: true);
    _timer = Timer(widget.debounce, () => _run(text));
  }

  Future<void> _run(String text) async {
    final res = await ModerationService.check(text, widget.fieldType);
    if (!mounted || widget.controller.text.trim() != text) return; // stale
    _lastChecked = text;
    if (res.allow) {
      _setState(error: null, checking: false);
      widget.onValidity?.call(true);
    } else {
      _setState(error: res.reason.isEmpty ? 'This content isn’t allowed here.' : res.reason, checking: false);
      widget.onValidity?.call(false);
    }
  }

  void _setState({String? error, bool? checking}) {
    if (!mounted) return;
    setState(() {
      if (error != null || checking == false) _error = error;
      if (checking != null) _checking = checking;
    });
  }

  @override
  Widget build(BuildContext context) {
    final base = widget.decoration ??
        InputDecoration(
          labelText: widget.label,
          hintText: widget.hint,
          border: const OutlineInputBorder(),
        );
    return TextField(
      controller: widget.controller,
      maxLines: widget.maxLines,
      maxLength: widget.maxLength,
      decoration: base.copyWith(
        errorText: _error,
        suffixIcon: _checking
            ? const Padding(
                padding: EdgeInsets.all(12),
                child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
              )
            : (_error == null && widget.controller.text.trim().isNotEmpty
                ? const Icon(Icons.check_circle, color: Colors.green, size: 20)
                : null),
      ),
    );
  }
}
