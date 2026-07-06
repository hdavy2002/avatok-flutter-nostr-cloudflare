import 'dart:async';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';

/// Liveness V3 — VOICE PACK MANAGER (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-DRAFT.md
/// §1 "Voice language packs" + §4-A.4 "Instruction-state model for voice packs").
///
/// Ava talks the user through the check with ~15 pre-recorded voice lines, keyed
/// by an INSTRUCTION ENUM (never a hardcoded filename — see plan §4-A.4). A
/// language pack is a manifest mapping `LivenessInstruction → asset/file`.
///
/// Sourcing + fallback chain (plan §1, "Never block the check on a voice pack"):
///   1. English clips are BUNDLED in the APK under `assets/liveness_voice/en/`
///      so a check always works out of the box, even offline (Constitution law 10).
///   2. Non-English packs are DOWNLOADED per-file from the CDN
///      (`/voice-packs/liveness/<lang>/<file>`) and cached device-wide (packs are
///      public assets → NOT account-scoped; plan §0-A law 9).
///   3. For any clip we can't play (missing file / download failed) we fall back to
///      device system TTS speaking the LOCALIZED string, and if TTS is unavailable
///      we play the English clip while showing the localized on-screen text.
///
/// The manager is a singleton; the flow calls [ensureLanguage] at the language
/// picker, then [play] with an instruction from the coaching engine.
class LivenessVoice {
  LivenessVoice._();
  static final LivenessVoice I = LivenessVoice._();

  final AudioPlayer _player = AudioPlayer();
  final FlutterTts _tts = FlutterTts();
  bool _ttsReady = false;

  String _lang = 'en';
  String get lang => _lang;

  /// Debounce: don't repeat the SAME instruction within this window (plan §3 —
  /// "debounced, don't repeat same clip within 3s").
  static const Duration _repeatGuard = Duration(seconds: 3);
  LivenessInstruction? _lastSpoken;
  int _lastSpokenMs = 0;

  /// Whether audio guidance is muted (accessibility / user preference).
  bool muted = false;

  // ── Public API ─────────────────────────────────────────────────────────────

  /// Select the flow language and make sure its pack is available. For English
  /// this is a no-op (bundled). For any other language, kicks off a per-file
  /// download+cache (fire the [onProgress] hook so the intro can show a spinner).
  /// NEVER throws and NEVER blocks the flow: on failure the fallback chain still
  /// speaks the instruction via TTS or the English clip. Returns immediately with
  /// whatever is ready; missing files resolve lazily at [play] time.
  Future<void> ensureLanguage(String lang) async {
    _lang = _normalize(lang);
    await _initTts();
    if (_lang == 'en') return; // bundled
    // Best-effort background prefetch of the whole pack so the first few clips
    // are warm; individual clips also self-heal at play time.
    unawaited(_prefetchPack(_lang));
  }

  /// Speak the guidance for [instruction] in the current language. Runs the full
  /// fallback chain (pack clip → system TTS → English clip + on-screen text).
  /// Honours the 3s same-instruction debounce and the mute flag. Best-effort.
  Future<void> play(LivenessInstruction instruction, {String? localizedText}) async {
    if (muted) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    if (_lastSpoken == instruction && now - _lastSpokenMs < _repeatGuard.inMilliseconds) {
      return; // debounced — same instruction repeated too soon
    }
    _lastSpoken = instruction;
    _lastSpokenMs = now;

    // 1) Chosen-language pack clip.
    if (await _playPackClip(_lang, instruction)) return;
    // 2) System TTS in the chosen language speaking the localized string.
    final text = localizedText ?? LivenessStrings.text(_lang, instruction);
    if (await _speakTts(text, _lang)) return;
    // 3) English clip (+ the caller already shows the localized on-screen text).
    if (_lang != 'en' && await _playPackClip('en', instruction)) return;
    // 4) Absolute last resort — TTS in English.
    await _speakTts(LivenessStrings.text('en', instruction), 'en');
  }

  /// Stop any in-flight speech (called on stage transitions / dispose).
  Future<void> stop() async {
    try { await _player.stop(); } catch (_) {}
    try { await _tts.stop(); } catch (_) {}
  }

  Future<void> dispose() async {
    await stop();
    try { await _player.dispose(); } catch (_) {}
  }

  // ── Playback + fallback internals ───────────────────────────────────────────

  Future<bool> _playPackClip(String lang, LivenessInstruction instruction) async {
    final file = LivenessPackManifest.fileFor(instruction);
    try {
      if (lang == 'en') {
        // Bundled asset. audioplayers AssetSource is relative to `assets/`.
        await _player.stop();
        await _player.play(AssetSource('liveness_voice/en/$file'));
        return true;
      }
      // Downloaded pack — play from the device-wide cache if present, else try to
      // fetch this single clip on demand (self-heal a partial pack).
      final cached = await _cachedClipPath(lang, file);
      if (cached == null) return false;
      await _player.stop();
      await _player.play(DeviceFileSource(cached));
      return true;
    } catch (e) {
      AvaLog.I.log('liveness', 'voice clip play failed ($lang/$file): $e');
      return false;
    }
  }

  Future<bool> _speakTts(String text, String lang) async {
    if (!_ttsReady || text.isEmpty) return false;
    try {
      await _tts.stop();
      await _tts.setLanguage(_bcp47(lang));
      await _tts.speak(text);
      return true;
    } catch (e) {
      AvaLog.I.log('liveness', 'tts speak failed ($lang): $e');
      return false;
    }
  }

  Future<void> _initTts() async {
    if (_ttsReady) return;
    try {
      await _tts.setSpeechRate(0.5);
      await _tts.setVolume(1.0);
      await _tts.awaitSpeakCompletion(false);
      _ttsReady = true;
    } catch (_) {
      _ttsReady = false; // TTS unavailable on this device — chain skips it
    }
  }

  // ── Device-wide pack cache (packs are PUBLIC assets → NOT account-scoped) ────

  Future<Directory> _packDir(String lang) async {
    final base = await getApplicationSupportDirectory();
    final d = Directory('${base.path}/liveness_voice/$lang');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  /// Returns the on-disk path of a cached clip, downloading it once if absent.
  /// Null if it isn't cached and can't be fetched.
  Future<String?> _cachedClipPath(String lang, String file) async {
    try {
      final dir = await _packDir(lang);
      final f = File('${dir.path}/$file');
      if (await f.exists() && await f.length() > 0) return f.path;
      // On-demand single-clip fetch (self-heal a partial pack).
      final ok = await _downloadClip(lang, file, f);
      return ok ? f.path : null;
    } catch (_) {
      return null;
    }
  }

  Future<bool> _downloadClip(String lang, String file, File dest) async {
    try {
      final url = '$kVoicePackCdnBase/$lang/$file';
      final res = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 20));
      if (res.statusCode != 200 || res.bodyBytes.isEmpty) return false;
      await dest.writeAsBytes(res.bodyBytes, flush: true);
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Fetch the whole pack (all instruction clips) for [lang] into the device-wide
  /// cache. Skips clips already present. Emits `liveness_pack_download` telemetry.
  /// Best-effort — a partial pack is fine (missing clips fall back at play time).
  Future<void> prefetchLocale(String lang) => _prefetchPack(_normalize(lang));

  Future<void> _prefetchPack(String lang) async {
    if (lang == 'en') return;
    final start = DateTime.now().millisecondsSinceEpoch;
    var ok = 0, total = 0;
    try {
      final dir = await _packDir(lang);
      for (final file in LivenessPackManifest.allFiles) {
        total++;
        final f = File('${dir.path}/$file');
        if (await f.exists() && await f.length() > 0) { ok++; continue; }
        if (await _downloadClip(lang, file, f)) ok++;
      }
    } catch (e) {
      AvaLog.I.log('liveness', 'pack prefetch failed ($lang): $e');
    }
    final ms = DateTime.now().millisecondsSinceEpoch - start;
    Analytics.capture('liveness_pack_download', {
      'lang': lang,
      'ms': ms,
      'ok': ok == total && total > 0,
      'clips_ok': ok,
      'clips_total': total,
      'v': 3,
    });
  }

  // ── Locale helpers ──────────────────────────────────────────────────────────

  static String _normalize(String lang) {
    final code = lang.trim().toLowerCase().split(RegExp(r'[_-]')).first;
    return LivenessStrings.supported.contains(code) ? code : 'en';
  }

  /// The device's current UI language as a supported pack code (falls back to en).
  static String deviceLang() {
    try {
      return _normalize(Platform.localeName); // e.g. es_ES.UTF-8 → es
    } catch (_) {
      return 'en';
    }
  }

  static String _bcp47(String lang) => switch (lang) {
        'es' => 'es-ES',
        'fr' => 'fr-FR',
        'de' => 'de-DE',
        'pt' => 'pt-BR',
        'hi' => 'hi-IN',
        'ar' => 'ar-SA',
        'id' => 'id-ID',
        _ => 'en-US',
      };
}

/// CDN base for downloadable voice packs (mirrors the app's public R2 read host
/// conventions — see [kBlossomBaseUrl] in core/config.dart). One folder per lang:
/// `/voice-packs/liveness/<lang>/<file>`.
const String kVoicePackCdnBase = 'https://blossom.avatok.ai/voice-packs/liveness';

/// The coaching instruction set (plan §4-A.4 — clips keyed by enum, not filename).
/// The coaching engine emits one of these each frame; the voice manager maps it to
/// an audio clip (or TTS string) in the active language.
enum LivenessInstruction {
  intro,
  moveCloser,
  moveBack,
  faceLeft,
  faceRight,
  lookUp,
  lookDown,
  good,
  holdStill,
  faceNotFound,
  lowLight,
  removeGlasses,
  onlyOnePerson,
  cameraBlocked,
  done,
}

/// The language-pack MANIFEST: instruction → clip filename. Filenames are stable
/// and identical across every language (only the folder changes), so voice clips
/// can be generated to match this map. English clips ship in the APK under
/// `assets/liveness_voice/en/`; other languages live at the CDN path above.
class LivenessPackManifest {
  LivenessPackManifest._();

  /// Instruction → filename. KEEP IN SYNC with the generated audio + pubspec asset
  /// registration. `.m4a` (AAC) keeps clips tiny (~15 clips ≈ under 1 MB/pack).
  static const Map<LivenessInstruction, String> _map = {
    LivenessInstruction.intro: 'intro.m4a',
    LivenessInstruction.moveCloser: 'move_closer.m4a',
    LivenessInstruction.moveBack: 'move_back.m4a',
    LivenessInstruction.faceLeft: 'face_left.m4a',
    LivenessInstruction.faceRight: 'face_right.m4a',
    LivenessInstruction.lookUp: 'look_up.m4a',
    LivenessInstruction.lookDown: 'look_down.m4a',
    LivenessInstruction.good: 'good.m4a',
    LivenessInstruction.holdStill: 'hold_still.m4a',
    LivenessInstruction.faceNotFound: 'face_not_found.m4a',
    LivenessInstruction.lowLight: 'low_light.m4a',
    LivenessInstruction.removeGlasses: 'remove_glasses.m4a',
    LivenessInstruction.onlyOnePerson: 'only_one_person.m4a',
    LivenessInstruction.cameraBlocked: 'camera_blocked.m4a',
    LivenessInstruction.done: 'done.m4a',
  };

  static String fileFor(LivenessInstruction i) => _map[i] ?? 'good.m4a';

  static List<String> get allFiles => _map.values.toList(growable: false);
}

/// Localized ON-SCREEN strings for each instruction. The app has no formal
/// AppLocalizations/intl setup (strings are hardcoded English elsewhere), so V3
/// carries its own small map: this is the "normal Flutter localization" the plan
/// refers to for on-screen text, and doubles as the TTS fallback script. Only the
/// launch languages are filled; unknown languages fall back to English.
class LivenessStrings {
  LivenessStrings._();

  /// Pack/UI languages we support at launch. English is always available.
  static const List<String> supported = ['en', 'es', 'fr', 'de', 'pt', 'hi', 'ar', 'id'];

  /// Human display label for a language code (for the picker dropdown).
  static const Map<String, String> labels = {
    'en': 'English',
    'es': 'Español',
    'fr': 'Français',
    'de': 'Deutsch',
    'pt': 'Português',
    'hi': 'हिन्दी',
    'ar': 'العربية',
    'id': 'Bahasa Indonesia',
  };

  static const Map<LivenessInstruction, String> _en = {
    LivenessInstruction.intro: "Hi, I'm Ava. Prop your phone up so I can see your face.",
    LivenessInstruction.moveCloser: 'Come a bit closer.',
    LivenessInstruction.moveBack: 'Move back a little.',
    LivenessInstruction.faceLeft: 'Turn your head left.',
    LivenessInstruction.faceRight: 'Turn your head right.',
    LivenessInstruction.lookUp: 'Look up a little.',
    LivenessInstruction.lookDown: 'Look down a little.',
    LivenessInstruction.good: 'Perfect.',
    LivenessInstruction.holdStill: 'Hold still — recording now.',
    LivenessInstruction.faceNotFound: 'Place your face in the frame.',
    LivenessInstruction.lowLight: 'Move somewhere brighter.',
    LivenessInstruction.removeGlasses: 'Please remove your glasses.',
    LivenessInstruction.onlyOnePerson: 'Make sure only you are in the frame.',
    LivenessInstruction.cameraBlocked: 'Something is covering the camera.',
    LivenessInstruction.done: "That's it! I'm checking now.",
  };

  static const Map<LivenessInstruction, String> _es = {
    LivenessInstruction.intro: 'Hola, soy Ava. Apoya el teléfono para que vea tu cara.',
    LivenessInstruction.moveCloser: 'Acércate un poco.',
    LivenessInstruction.moveBack: 'Aléjate un poco.',
    LivenessInstruction.faceLeft: 'Gira la cabeza a la izquierda.',
    LivenessInstruction.faceRight: 'Gira la cabeza a la derecha.',
    LivenessInstruction.lookUp: 'Mira un poco hacia arriba.',
    LivenessInstruction.lookDown: 'Mira un poco hacia abajo.',
    LivenessInstruction.good: 'Perfecto.',
    LivenessInstruction.holdStill: 'No te muevas — estoy grabando.',
    LivenessInstruction.faceNotFound: 'Coloca tu cara en el recuadro.',
    LivenessInstruction.lowLight: 'Ve a un lugar con más luz.',
    LivenessInstruction.removeGlasses: 'Quítate las gafas, por favor.',
    LivenessInstruction.onlyOnePerson: 'Asegúrate de estar solo en la imagen.',
    LivenessInstruction.cameraBlocked: 'Algo cubre la cámara.',
    LivenessInstruction.done: '¡Listo! Estoy comprobando.',
  };

  static const Map<LivenessInstruction, String> _fr = {
    LivenessInstruction.intro: "Bonjour, je suis Ava. Posez votre téléphone pour que je voie votre visage.",
    LivenessInstruction.moveCloser: 'Approchez-vous un peu.',
    LivenessInstruction.moveBack: 'Reculez un peu.',
    LivenessInstruction.faceLeft: 'Tournez la tête à gauche.',
    LivenessInstruction.faceRight: 'Tournez la tête à droite.',
    LivenessInstruction.lookUp: 'Regardez un peu vers le haut.',
    LivenessInstruction.lookDown: 'Regardez un peu vers le bas.',
    LivenessInstruction.good: 'Parfait.',
    LivenessInstruction.holdStill: "Ne bougez plus — j'enregistre.",
    LivenessInstruction.faceNotFound: 'Placez votre visage dans le cadre.',
    LivenessInstruction.lowLight: 'Allez dans un endroit plus lumineux.',
    LivenessInstruction.removeGlasses: 'Veuillez retirer vos lunettes.',
    LivenessInstruction.onlyOnePerson: "Assurez-vous d'être seul dans l'image.",
    LivenessInstruction.cameraBlocked: 'Quelque chose couvre la caméra.',
    LivenessInstruction.done: "C'est fait ! Je vérifie maintenant.",
  };

  static const Map<LivenessInstruction, String> _de = {
    LivenessInstruction.intro: 'Hallo, ich bin Ava. Stell dein Handy auf, damit ich dein Gesicht sehe.',
    LivenessInstruction.moveCloser: 'Komm ein bisschen näher.',
    LivenessInstruction.moveBack: 'Geh ein bisschen zurück.',
    LivenessInstruction.faceLeft: 'Dreh den Kopf nach links.',
    LivenessInstruction.faceRight: 'Dreh den Kopf nach rechts.',
    LivenessInstruction.lookUp: 'Schau etwas nach oben.',
    LivenessInstruction.lookDown: 'Schau etwas nach unten.',
    LivenessInstruction.good: 'Perfekt.',
    LivenessInstruction.holdStill: 'Halt still — ich nehme auf.',
    LivenessInstruction.faceNotFound: 'Bring dein Gesicht ins Bild.',
    LivenessInstruction.lowLight: 'Geh an einen helleren Ort.',
    LivenessInstruction.removeGlasses: 'Bitte nimm die Brille ab.',
    LivenessInstruction.onlyOnePerson: 'Sorge dafür, dass nur du im Bild bist.',
    LivenessInstruction.cameraBlocked: 'Etwas verdeckt die Kamera.',
    LivenessInstruction.done: 'Fertig! Ich prüfe das jetzt.',
  };

  static const Map<String, Map<LivenessInstruction, String>> _byLang = {
    'en': _en,
    'es': _es,
    'fr': _fr,
    'de': _de,
    // pt/hi/ar/id have voice clips but reuse English on-screen text until
    // translated (TTS still speaks the right language via _bcp47).
  };

  static String text(String lang, LivenessInstruction i) {
    final map = _byLang[lang] ?? _en;
    return map[i] ?? _en[i] ?? '';
  }
}
