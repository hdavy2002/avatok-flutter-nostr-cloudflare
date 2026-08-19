package ai.avatok.streamcall

import io.flutter.embedding.engine.plugins.FlutterPlugin

/**
 * Flutter tooling discovery marker.
 *
 * The Android build selects the real [FlutterPlugin] implementation from either
 * src/pilot or src/stub. This standard-path file is deliberately excluded by
 * that source-set selection, but must exist so `flutter create` can identify the
 * plugin and generate its v2 embedding registration before Gradle is invoked.
 */
internal object StreamCallBridgeDiscoveryMarker
