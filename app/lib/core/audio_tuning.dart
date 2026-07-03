// Shared voice audio tuning (FREE LAUNCH §2, Specs/FREE-LAUNCH-DIRECTION.md).
// Used by the 1:1 P2P path (call_screen.dart) and the CF-SFU group-audio path
// (features/conference/sfu_group_call_screen.dart) so capture DSP + Opus encoder
// settings are defined ONCE.

/// getUserMedia audio constraints with echo cancellation + noise suppression +
/// auto gain. Both the W3C keys and the legacy goog* mandatory keys are sent so
/// the DSP chain is on across WebRTC backends.
Map<String, dynamic> avaMicConstraints() => {
      'echoCancellation': true,
      'noiseSuppression': true,
      'autoGainControl': true,
      'mandatory': {
        'googEchoCancellation': true,
        'googNoiseSuppression': true,
        'googAutoGainControl': true,
        'googHighpassFilter': true,
      },
      'optional': [],
    };

/// Tune the Opus encoder on a LOCAL SDP for voice — in-band FEC (packet-loss
/// resilience), DTX (silence suppression → less bandwidth), and a ~40 kbps
/// average-bitrate cap (the 32–48 kbps voice sweet spot). Only the opus
/// `a=fmtp` line is rewritten; everything else is untouched. No-op when no opus
/// payload exists.
String tuneOpusSdp(String? sdp) {
  if (sdp == null || sdp.isEmpty) return sdp ?? '';
  final pts = RegExp(r'a=rtpmap:(\d+) opus/', caseSensitive: false)
      .allMatches(sdp)
      .map((m) => m.group(1)!)
      .toSet();
  if (pts.isEmpty) return sdp;
  const want = <String, String>{
    'useinbandfec': '1',
    'usedtx': '0',
    'maxaveragebitrate': '56000',
    'stereo': '0',
  };
  final lines = sdp.split(RegExp(r'\r\n|\n'));
  for (var i = 0; i < lines.length; i++) {
    for (final pt in pts) {
      final prefix = 'a=fmtp:$pt ';
      if (!lines[i].startsWith(prefix)) continue;
      final params = <String, String>{};
      for (final kv in lines[i].substring(prefix.length).split(';')) {
        final t = kv.trim();
        if (t.isEmpty) continue;
        final eq = t.indexOf('=');
        if (eq < 0) {
          params[t] = '';
        } else {
          params[t.substring(0, eq)] = t.substring(eq + 1);
        }
      }
      params.addAll(want);
      lines[i] = prefix +
          params.entries
              .map((e) => e.value.isEmpty ? e.key : '${e.key}=${e.value}')
              .join(';');
    }
  }
  return lines.join('\r\n');
}
