import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../../core/brand.dart';

/// [HF-MERCH-STUDIO-2] The 16 print fonts of the merch studio (same list and files as the web studio, studio/fonts.ts; spec section 4).
/// Static OFL / Apache TTFs served at `<site>/fonts/merch/<file>`. They are fetched on demand when the studio needs them (never at
/// app start) and registered with [FontLoader]. The UI chrome stays Nunito / Comfortaa.
class MerchFont {
  const MerchFont(this.family, this.file, this.label, this.devanagari);

  /// Display name; also what `TextDesignLayer.font` stores.
  final String family;
  final String file;
  final String label;

  /// True when the font draws Devanagari (Hindi) letters.
  final bool devanagari;

  String get sample => devanagari ? 'नमस्ते दोस्तों' : label;

  /// The name registered with the engine (prefixed so it never clashes with an app font such as Poppins).
  String get flutterFamily => 'hfm_$family';
}

const List<MerchFont> kMerchFonts = <MerchFont>[
  MerchFont('Yatra One', 'YatraOne-Regular.ttf', 'Yatra One', true),
  MerchFont('Rozha One', 'RozhaOne-Regular.ttf', 'Rozha One', true),
  MerchFont('Kalam', 'Kalam-Bold.ttf', 'Kalam', true),
  MerchFont('Khand', 'Khand-Bold.ttf', 'Khand', true),
  MerchFont('Mukta', 'Mukta-ExtraBold.ttf', 'Mukta', true),
  MerchFont('Tiro Devanagari Hindi', 'TiroDevanagariHindi-Regular.ttf', 'Tiro Devanagari', true),
  MerchFont('Sahitya', 'Sahitya-Bold.ttf', 'Sahitya', true),
  MerchFont('Poppins', 'Poppins-ExtraBold.ttf', 'Poppins', true),
  MerchFont('Anton', 'Anton-Regular.ttf', 'Anton', false),
  MerchFont('Bebas Neue', 'BebasNeue-Regular.ttf', 'Bebas Neue', false),
  MerchFont('Pacifico', 'Pacifico-Regular.ttf', 'Pacifico', false),
  MerchFont('Permanent Marker', 'PermanentMarker-Regular.ttf', 'Permanent Marker', false),
  MerchFont('Lobster', 'Lobster-Regular.ttf', 'Lobster', false),
  MerchFont('Abril Fatface', 'AbrilFatface-Regular.ttf', 'Abril Fatface', false),
  MerchFont('Righteous', 'Righteous-Regular.ttf', 'Righteous', false),
  MerchFont('Bangers', 'Bangers-Regular.ttf', 'Bangers', false),
];

const String kDefaultMerchFont = 'Yatra One';

MerchFont merchFontOf(String family) {
  for (final f in kMerchFonts) {
    if (f.family == family) return f;
  }
  return kMerchFonts.first;
}

/// Runtime font registry. Loaded once per run (kept in memory); a failed load can be tried again.
abstract final class MerchFonts {
  /// Bumps after every font that finished (or failed) so painters and panels redraw.
  static final ValueNotifier<int> changes = ValueNotifier<int>(0);

  static final Map<String, Future<void>> _running = <String, Future<void>>{};
  static final Set<String> _done = <String>{};
  static final Set<String> _failed = <String>{};

  static bool isLoaded(String family) => _done.contains(family);
  static bool hasFailed(String family) => _failed.contains(family);

  /// The family name to draw with: the font once loaded, otherwise the app font (so text is never blank).
  static String flutterFamily(String family) => _done.contains(family) ? merchFontOf(family).flutterFamily : 'Nunito';

  /// Loads one font. Throws when the file cannot be fetched.
  static Future<void> load(String family) {
    if (_done.contains(family)) return Future<void>.value();
    final known = kMerchFonts.where((f) => f.family == family);
    if (known.isEmpty) return Future<void>.value();
    return _running.putIfAbsent(family, () => _fetch(known.first));
  }

  static Future<void> _fetch(MerchFont font) async {
    try {
      final res = await http.get(Uri.parse(Brand.url('/fonts/merch/${font.file}'))).timeout(const Duration(seconds: 45));
      if (res.statusCode != 200 || res.bodyBytes.isEmpty) throw StateError('font_http_${res.statusCode}');
      final bytes = res.bodyBytes;
      final loader = FontLoader(font.flutterFamily)
        ..addFont(Future<ByteData>.value(ByteData.view(bytes.buffer, bytes.offsetInBytes, bytes.lengthInBytes)));
      await loader.load();
      _done.add(font.family);
      _failed.remove(font.family);
    } catch (_) {
      _failed.add(font.family);
      rethrow;
    } finally {
      _running.remove(font.family)?.ignore();
      changes.value++;
    }
  }

  /// Starts loading and ignores the outcome (the UI shows a spinner or the fallback font).
  static void loadQuiet(String family) {
    unawaited(load(family).catchError((Object _) {}));
  }

  /// Loads several fonts in parallel; returns the families that failed.
  static Future<List<String>> loadAll(Iterable<String> families) async {
    final list = families.toSet().toList();
    final failed = <String>[];
    await Future.wait(<Future<void>>[
      for (final f in list)
        load(f).catchError((Object _) {
          failed.add(f);
        }),
    ]);
    return failed;
  }
}
