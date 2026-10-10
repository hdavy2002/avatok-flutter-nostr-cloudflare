import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/me_api.dart';
import '../data/me_telemetry.dart';

abstract final class NameCopy {
  static const String title = 'Your name';
  static const String hint = 'Callers and hosts see only this name.';
  static const String label = 'Name';
  static const String save = 'Save';
  static const String empty = 'Please enter your name.';
}

/// The bottom sheet that changes the person's name (`PATCH /api/hf/me`). The worker checks the name (2 to 40
/// characters, no numbers, no phone numbers or links) and answers `400 invalid_field {field:'displayName', message}`;
/// that message is shown right under the field. Pops with the saved name.
class NameSheet extends ConsumerStatefulWidget {
  const NameSheet({super.key, this.initial = ''});

  final String initial;

  @override
  ConsumerState<NameSheet> createState() => _NameSheetState();
}

class _NameSheetState extends ConsumerState<NameSheet> {
  late final TextEditingController _controller = TextEditingController(text: widget.initial);
  String? _error;
  bool _saving = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_saving) return;
    final name = _controller.text.trim();
    if (name.isEmpty) {
      MeTelemetry.nameUpdated('failed', reason: 'empty');
      setState(() => _error = NameCopy.empty);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final saved = await ref.read(meApiProvider).updateName(name);
      MeTelemetry.nameUpdated('ok');
      if (!mounted) return;
      Navigator.of(context).pop(saved);
    } on ApiError catch (e) {
      MeTelemetry.nameUpdated('failed', reason: e.code, status: e.status);
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = e.userMessage;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(HfSpacing.page, 0, HfSpacing.page, HfSpacing.page + bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(NameCopy.title, style: HfText.title),
            const SizedBox(height: 6),
            const Text(NameCopy.hint, style: HfText.note),
            const SizedBox(height: 16),
            TextField(
              key: const ValueKey<String>('name-field'),
              controller: _controller,
              autofocus: true,
              enabled: !_saving,
              maxLength: 40,
              textCapitalization: TextCapitalization.words,
              textInputAction: TextInputAction.done,
              style: HfText.bodyText,
              decoration: InputDecoration(
                labelText: NameCopy.label,
                errorText: _error,
                errorMaxLines: 3,
                counterText: '',
              ),
              onChanged: (_) {
                if (_error != null) setState(() => _error = null);
              },
              onSubmitted: (_) => unawaited(_save()),
            ),
            const SizedBox(height: 16),
            HfButton(
              key: const ValueKey<String>('name-save'),
              label: NameCopy.save,
              loading: _saving,
              onPressed: () => unawaited(_save()),
            ),
          ],
        ),
      ),
    );
  }
}
