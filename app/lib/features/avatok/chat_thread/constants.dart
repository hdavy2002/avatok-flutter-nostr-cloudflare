part of '../chat_thread.dart';

// [CHAT-THREAD-SPLIT-1] Former `static` members of `_ChatThreadScreenState`,
// hoisted verbatim to library-private top level. An extension body cannot
// reference the extended type's statics unqualified, and these are all
// self-contained, so hoisting keeps every existing call site unchanged.

const _kTransLangKey = 'composer_translate_lang';

const _kHideDeletedKey = 'chat_hide_deleted';

const String _kSenderPubRepairKey = 'grp_senderpub_repaired_v1';

/// The shell-wide Pill Morse footer overlays the bottom 27dp of every root.
/// Keep the live composer above it so the field and send/mic stay unobscured.
const double _kShellFooterClearance = 27;

/// The wake words the composer watches for. `@ava` = a PRIVATE personal call
/// to Ava (never sent to the peer, private reply). `#ava` = a SHARED call (both
/// parties see the question + reply).
const String _avaWakeWord = '@ava';

const String _avaShareWord = '#ava';

/// Pick a file extension from a content type, falling back to the media kind.
String _extFor(String contentType, MediaKind kind) {
  final ct = contentType.toLowerCase();
  if (ct.contains('png')) return '.png';
  if (ct.contains('jpeg') || ct.contains('jpg')) return '.jpg';
  if (ct.contains('gif')) return '.gif';
  if (ct.contains('webp')) return '.webp';
  if (ct.contains('mp4') && kind == MediaKind.audio) return '.m4a';
  if (ct.contains('mp4')) return '.mp4';
  if (ct.contains('quicktime') || ct.contains('mov')) return '.mov';
  if (ct.contains('wav')) return '.wav';
  if (ct.contains('mpeg') && kind == MediaKind.audio) return '.mp3';
  if (ct.contains('mp3')) return '.mp3';
  if (ct.contains('ogg') || ct.contains('opus')) return '.ogg';
  if (ct.contains('pdf')) return '.pdf';
  switch (kind) {
    case MediaKind.image: return '.jpg';
    case MediaKind.video: return '.mp4';
    case MediaKind.audio: return '.m4a';
    case MediaKind.file: return '';
  }
}

/// A short random id for a media bubble's durable-outbox row / staged file
/// name. Independent of the message's eventual `evId` (assigned once the
/// envelope is actually sent) — this one exists from the moment the bubble
/// appears, so [MediaOutbox] can key off it before there's anything else to
/// key off.
String _newMediaClientId() {
  final r = math.Random.secure();
  return 'mc_${List<int>.generate(10, (_) => r.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
}

/// [MEDIA-RETRY-KIND-1] Whether [mime] is a plausible content-type for
/// [kind] — the guard that stops a retry from silently reclassifying an
/// attachment (e.g. re-uploading a failed voice note tagged `video/mp4`,
/// which would upload-succeed but render wrong for both sender and peer).
bool _kindMimeCompatible(MediaKind kind, String mime) {
  final m = mime.toLowerCase();
  if (m.isEmpty) return false;
  switch (kind) {
    case MediaKind.image: return m.startsWith('image/');
    case MediaKind.video: return m.startsWith('video/');
    case MediaKind.audio: return m.startsWith('audio/') || m == 'video/mp4' /* .m4a rides on mp4 container */;
    case MediaKind.file: return true; // generic files have no fixed mime family
  }
}

const int _kMediaMaxBytes = 25 * 1024 * 1024;

const int _kMaxPhotosPerPick = 8;

const int _kVideoMaxBytes = 64 * 1024 * 1024; // 64 MB (VIDPOL-1/2)

const String _kVideoTooBigMsg =
    'Videos are limited to 64 MB (about 3–5 minutes). Trim it and try again.';

const int _kRecMaxBars = 46;

const _reactionSounds = {
  '❤️': 'heart', '👍': 'like', '😂': 'laugh', '😮': 'wow', '😢': 'sad', '👏': 'clap',
};

const Map<String, List<String>> _emojiCatalog = {
  'Smileys': ['😀','😁','😂','🤣','😊','😍','😘','😎','🤩','😢','😭','😡','🥺','🤔','😴','🤯','😱','🥳','😅','😉','🙃','😇','🤗','🤭','😬','🙄','😏','😌','🤤','🤪'],
  'Gestures': ['👍','👎','👏','🙏','🤝','💪','👊','✊','🤞','✌️','🤟','🤙','👌','🖐️','✋','👋','🫶','🫰','👇','👆'],
  'Hearts': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','❤️‍🔥'],
  'Fun': ['🔥','🎉','🎊','✨','⭐','🌟','💯','🚀','🏆','🎈','🎁','💎','👑','💥','💫','🌈','☀️','⚡','🍾','🥂'],
  'Animals': ['🐶','🐱','🦄','🐼','🦁','🐯','🐸','🐵','🐧','🐢','🦋','🐝','🐬','🐳','🦊','🐰','🐨','🐮','🐷','🐙'],
  'Food': ['🍕','🍔','🍟','🌮','🍣','🍦','🍩','🍪','🎂','🍰','🍫','🍿','☕','🍺','🍷','🥤','🍓','🍉','🍌','🥑'],
};

const String _kPasteHintKey = 'chat_paste_hint_shown';

/// Normalise text for in-thread search: lower-case and strip the most common
/// accents so "cafe" matches "café" and case never matters. Keeps it simple —
/// no full Unicode NFD dependency.
String _foldSearch(String s) {
  var t = s.toLowerCase();
  const from = 'áàâäãåéèêëíìîïóòôöõúùûüñçý';
  const to = 'aaaaaaeeeeiiiiooooouuuuncy';
  final b = StringBuffer();
  for (final ch in t.split('')) {
    final i = from.indexOf(ch);
    b.write(i >= 0 ? to[i] : ch);
  }
  return b.toString().trim();
}

String _brainSearchUrl() {
  final origin = kApiBase.endsWith('/api')
      ? kApiBase.substring(0, kApiBase.length - '/api'.length)
      : kApiBase;
  return '$origin${AvaApi.brainThreadSearch}';
}
