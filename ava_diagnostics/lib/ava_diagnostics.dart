/// Shared AvaVerse diagnostics.
///
/// Usage in any app:
///   AvaLog.I.app = 'avachat';                 // set the app key once at startup
///   AvaLog.I.sink = (e) => Posthog().capture( // wire to PostHog once it's ready
///       eventName: 'diag_log',
///       properties: {'tag': e.tag, 'level': e.level, 'line': e.line,
///                    'log_app': AvaLog.I.app, 'session': AvaLog.I.session});
///   // then anywhere:
///   AvaLog.I.log('relay', 'connected');
///   AvaLog.I.warn('call', 'no device');
///
/// Identify the person by npub (NOT email — no PII) so logs are pullable by
/// resolving an email to its npub server-side.
library ava_diagnostics;

export 'src/ava_log.dart';
