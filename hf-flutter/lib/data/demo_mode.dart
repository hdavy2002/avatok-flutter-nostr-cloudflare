/// Live data is the default for every build, including local APKs.
/// Opt into dummy data explicitly with --dart-define=HF_DEMO=true.
abstract final class DemoMode {
  static const bool on = bool.fromEnvironment('HF_DEMO', defaultValue: false);
}
