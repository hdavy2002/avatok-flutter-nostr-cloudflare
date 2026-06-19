/// Bundled ringtone catalog (Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md).
///
/// PIVOT (2026-06-19): instead of AI-generating tones per user, we ship a fixed
/// set of original, royalty-free ringtones IN the app and let users preview +
/// pick one as their ringback — exactly like a phone's built-in ringtone picker.
/// Fast, free, offline. The server only stores WHICH tone id each user picked;
/// the caller plays the callee's chosen tone from its OWN bundled copy (no
/// download). Tone ids must stay STABLE — they are what the server stores and
/// what the caller maps back to a local asset.
library;

class RingtoneItem {
  final String id;    // stable key stored server-side
  final String name;  // shown in the picker
  final String asset; // bundled asset path (AssetSource strips the assets/ prefix)
  const RingtoneItem(this.id, this.name, this.asset);
}

/// The catalog. Keep ids stable across releases; add new tones at the end.
const List<RingtoneItem> kRingtoneCatalog = [
  RingtoneItem('pulse', 'Pulse', 'assets/audio/catalog/pulse.mp3'),
  RingtoneItem('marimba', 'Marimba', 'assets/audio/catalog/marimba.mp3'),
  RingtoneItem('chimes', 'Chimes', 'assets/audio/catalog/chimes.mp3'),
  RingtoneItem('arcade', 'Arcade', 'assets/audio/catalog/arcade.mp3'),
  RingtoneItem('sunrise', 'Sunrise', 'assets/audio/catalog/sunrise.mp3'),
  RingtoneItem('bubbles', 'Bubbles', 'assets/audio/catalog/bubbles.mp3'),
  RingtoneItem('classic', 'Classic', 'assets/audio/catalog/classic.mp3'),
  RingtoneItem('lofi', 'Lo-Fi', 'assets/audio/catalog/lofi.mp3'),
];

/// Look up a catalog item by id (null if unknown — e.g. a newer id than this
/// build knows about; callers fall back to the default ringback then).
RingtoneItem? ringtoneById(String id) {
  for (final r in kRingtoneCatalog) {
    if (r.id == id) return r;
  }
  return null;
}
