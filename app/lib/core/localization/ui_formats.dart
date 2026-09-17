import 'package:intl/intl.dart';
import 'ui_locale_controller.dart';
import 'ui_messages.dart';

class UiFormats {
  static String get _locale => UiLocaleController.instance.selected.code.replaceAll('-', '_');
  static String number(num value) {
    try { return NumberFormat.decimalPattern(_locale).format(value); }
    catch (_) { return NumberFormat.decimalPattern('en').format(value); }
  }
  static String date(DateTime value) {
    try { return DateFormat.yMMMd(_locale).format(value); }
    catch (_) { return DateFormat.yMMMd('en').format(value); }
  }
  static String plural(num count, {required UiMessage other, UiMessage? zero,
      UiMessage? one, UiMessage? two, UiMessage? few, UiMessage? many}) {
    UiMessage key;
    try {
      key = Intl.pluralLogic<UiMessage>(count, locale: _locale,
          zero: zero, one: one, two: two, few: few, many: many, other: other);
    } catch (_) { key = count == 1 ? (one ?? other) : other; }
    return UiLocaleController.instance.text(key, {'count': number(count)});
  }
}
