import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/theme/hf_tokens.dart';

/// Six boxes for the WhatsApp code. A real [TextField] (transparent) sits over the boxes, so the number keyboard,
/// paste and one-time-code autofill all work and a tap anywhere on the boxes opens the keyboard.
/// [onCompleted] fires when the sixth digit is in.
class CodeBoxes extends StatelessWidget {
  const CodeBoxes({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.onCompleted,
    this.hasError = false,
    this.enabled = true,
    this.length = 6,
    this.fieldKey = const ValueKey<String>('signin-code'),
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final VoidCallback onCompleted;
  final bool hasError;
  final bool enabled;
  final int length;
  final Key fieldKey;

  static const double boxHeight = 60;
  static const double gap = 8;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: boxHeight,
      child: Stack(
        children: [
          Positioned.fill(
            child: ExcludeSemantics(
              child: ListenableBuilder(
                listenable: Listenable.merge([controller, focusNode]),
                builder: (context, _) => LayoutBuilder(
                  builder: (context, box) {
                    final width = (box.maxWidth - gap * (length - 1)) / length;
                    final text = controller.text;
                    return Row(
                      children: [
                        for (var i = 0; i < length; i++) ...[
                          if (i > 0) const SizedBox(width: gap),
                          _Box(
                            width: width,
                            digit: i < text.length ? text[i] : '',
                            active: enabled && focusNode.hasFocus && i == text.length.clamp(0, length - 1),
                            hasError: hasError,
                          ),
                        ],
                      ],
                    );
                  },
                ),
              ),
            ),
          ),
          Positioned.fill(
            child: Semantics(
              label: 'Code from WhatsApp, $length digits',
              textField: true,
              child: TextField(
                key: fieldKey,
                controller: controller,
                focusNode: focusNode,
                enabled: enabled,
                autofocus: true,
                expands: true,
                maxLines: null,
                minLines: null,
                keyboardType: TextInputType.number,
                textInputAction: TextInputAction.done,
                autofillHints: const [AutofillHints.oneTimeCode],
                enableInteractiveSelection: false,
                showCursor: false,
                cursorColor: Colors.transparent,
                style: const TextStyle(color: Colors.transparent, fontSize: 14),
                decoration: const InputDecoration.collapsed(hintText: null),
                inputFormatters: [
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(length),
                ],
                onChanged: (v) {
                  if (v.length == length) onCompleted();
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Box extends StatelessWidget {
  const _Box({required this.width, required this.digit, required this.active, required this.hasError});

  final double width;
  final String digit;
  final bool active;
  final bool hasError;

  @override
  Widget build(BuildContext context) {
    final border = hasError ? HfColors.accent : (active ? HfColors.orchid : HfColors.line);
    return Container(
      width: width,
      height: CodeBoxes.boxHeight,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: HfColors.white,
        borderRadius: BorderRadius.circular(HfRadius.control),
        border: Border.all(color: border, width: active || hasError ? 2 : 1.5),
      ),
      child: Text(digit, style: HfText.title),
    );
  }
}
