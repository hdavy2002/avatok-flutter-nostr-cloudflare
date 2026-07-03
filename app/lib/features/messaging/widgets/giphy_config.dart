// GIPHY SDK configuration (STREAM E — Tenor→GIPHY migration).
//
// Tenor was shut down; the GIF/sticker/text/emoji/clips picker now uses the
// official GIPHY Flutter SDK (`giphy_flutter_sdk`). The SDK is configured once,
// lazily, on the first open of the picker (see GiphyController.ensureConfigured).
//
// ABOUT THIS KEY: `kGiphySdkKey` is a GIPHY *SDK* key (owner-provisioned for the
// Android/iOS SDK). Unlike our server-side REST keys, a GIPHY SDK key is a CLIENT
// credential — it is designed to ship inside the app binary (the native SDK sends
// it directly to GIPHY from the device), so embedding it here is expected and
// safe by GIPHY's own design. It is DISTINCT from the server `GIPHY_API_KEY`
// secret used by our worker fallback proxy (worker/src/routes/gif.ts). The same
// value is mirrored (for the record) in secrets/secret-values.env as GIPHY_SDK_KEY.
//
// GIPHY recommends a separate key per platform. The owner supplied an Android SDK
// key; until a distinct iOS SDK key is provisioned we reuse the same value on iOS
// (functional — swap in the iOS key here when available).
library;

/// GIPHY Android SDK key (owner-provided). Client SDK credential — ships in-app.
const String kGiphyAndroidSdkKey = '15eybJKLPUbjT31eVmfox3NSJl6xx2ad';

/// GIPHY iOS SDK key. TODO(owner): provision a dedicated iOS SDK key in the GIPHY
/// developer dashboard and paste it here. Reusing the Android key works for now.
const String kGiphyIosSdkKey = '15eybJKLPUbjT31eVmfox3NSJl6xx2ad';
