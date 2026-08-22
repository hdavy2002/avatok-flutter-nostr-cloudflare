package ai.avatok.realtimekit_disabled;

import androidx.annotation.NonNull;
import io.flutter.embedding.engine.plugins.FlutterPlugin;

/**
 * Intentionally empty: Cloudflare RealtimeKit calls are dark while AvaTOK uses
 * Stream. Keeping a registered no-op avoids packaging its conflicting native
 * WebRTC and AudioSwitch engines without disturbing dormant Dart code.
 */
public final class DisabledRealtimeKitPlugin implements FlutterPlugin {
  @Override
  public void onAttachedToEngine(@NonNull FlutterPluginBinding binding) {}

  @Override
  public void onDetachedFromEngine(@NonNull FlutterPluginBinding binding) {}
}
