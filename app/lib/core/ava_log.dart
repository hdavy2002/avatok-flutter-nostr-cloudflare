// AvaLog now lives in the shared `ava_diagnostics` package so every AvaVerse app
// uses one consistent diagnostics system. This re-export keeps existing
// `import '../core/ava_log.dart';` sites working unchanged.
export 'package:ava_diagnostics/ava_diagnostics.dart';
