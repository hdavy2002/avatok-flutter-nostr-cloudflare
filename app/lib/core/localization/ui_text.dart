import 'package:flutter/material.dart';
import 'ui_locale_controller.dart';
import 'ui_messages.dart';
import 'ui_font_policy.dart';
export 'ui_messages.dart';

/// Const-compatible replacement for authored Text literals. Dynamic/user text
/// stays a normal Text; only registered public UI messages enter catalogs.
class UiText extends Text {
  final UiMessage message;
  final Map<String, Object> params;
  const UiText(this.message, {
    this.params = const {}, super.key, super.style, super.strutStyle,
    super.textAlign, super.textDirection, super.locale, super.softWrap,
    super.overflow, super.textScaler, super.maxLines, super.semanticsLabel,
    super.textWidthBasis, super.textHeightBehavior,
  }) : super('');

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: UiLocaleController.instance,
    builder: (context, _) => Text(
      UiLocaleController.instance.text(message, params),
      style: UiFontPolicy.style(style ?? DefaultTextStyle.of(context).style),
      strutStyle: strutStyle, textAlign: textAlign, textDirection: textDirection,
      locale: locale ?? UiLocaleController.instance.selected.locale,
      softWrap: softWrap, overflow: overflow, textScaler: textScaler,
      maxLines: maxLines, semanticsLabel: semanticsLabel,
      textWidthBasis: textWidthBasis, textHeightBehavior: textHeightBehavior,
    ),
  );
}

/// Authored UI attributes; rebuild through the root locale listener.
String uiCopy(UiMessage message, [Map<String, Object> params = const {}]) =>
    UiLocaleController.instance.text(message, params);

/// Registers attribute-bearing widgets as dependents even when their enclosing
/// route/parent is const. Locale switches preserve Navigator and form state.
class UiLocaleScope extends InheritedNotifier<UiLocaleController> {
  UiLocaleScope({super.key, required super.child})
      : super(notifier: UiLocaleController.instance);
  static void watch(BuildContext context) {
    context.dependOnInheritedWidgetOfExactType<UiLocaleScope>();
  }
}

/// For app-owned menu/registry metadata and known auth UI errors only.
/// Never call this on names, messages, listing descriptions or other user data.
final _authoredUiKeys = <String, UiMessage>{
  for (final key in UiMessage.values) uiSourceMessages[key.name]!: key,
};
String authoredUiCopy(String source) {
  final key = _authoredUiKeys[source];
  return key == null ? source : uiCopy(key);
}
