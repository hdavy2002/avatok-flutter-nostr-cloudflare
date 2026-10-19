/// The demo switch. While `true` (the default) every screen still reads the dummy data in
/// `lib/demo/data.dart` and `lib/demo/state.dart`. Later stages replace screens one at a time with
/// repository-backed versions and check this flag to decide which to show; stage HF-WIRE-12 removes it.
///
/// Build without dummy data: `flutter build apk --dart-define=HF_DEMO=false`.
abstract final class DemoMode {
  static const bool on = bool.fromEnvironment('HF_DEMO', defaultValue: true);
}
