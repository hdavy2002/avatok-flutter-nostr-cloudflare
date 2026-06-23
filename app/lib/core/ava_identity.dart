/// Canonical identity for Ava — ONE source of truth for her name and avatar so
/// every surface (chat bubbles, ChatAVA, AI Voice Agent, …) shows the same face.
///
/// The avatar is a bundled asset. To change Ava's photo sitewide, replace
/// `app/assets/ava/ava_avatar.png` (a placeholder ships today) — no code change.
class AvaId {
  static const String name = 'Ava';

  /// Bundled avatar asset (registered under `flutter: assets:` in pubspec.yaml).
  /// Callers should render with an errorBuilder fallback in case it's missing.
  static const String avatarAsset = 'assets/ava/ava_avatar.png';
}
