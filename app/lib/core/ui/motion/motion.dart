/// [UI-MOTION-LIB] The motion library — small, composable, expensive-feeling
/// transitions built on `Msg`'s duration/curve scale.
///
/// The August UI audit's motion finding was overshoot curves and 16
/// always-on looping animations reading as amateurish. This library's fix is
/// two-fold: every curve here is [Msg.settle] unless the widget's own doc
/// comment names a specific exception the audit explicitly allowed (numbers,
/// one reward moment), and nothing loops without an explicit `active` flag a
/// caller must turn off.
///
/// The signature move throughout is a 2-3px cross-blur paired with a short
/// travel — that combination reads as far more distance and weight than a
/// long slide alone, without the swim a long slide brings.
///
/// Import this single file rather than the individual widget files.
library;

export 'ad_accordion.dart';
export 'ad_dot_loader.dart';
export 'ad_pop_number.dart';
export 'ad_press.dart';
export 'ad_scale_route.dart';
export 'ad_shimmer_text.dart';
export 'ad_skeleton.dart';
export 'ad_slide_tabs.dart';
export 'ad_success_check.dart';
export 'ad_switch_text.dart';
export 'ad_toast.dart';
