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

/// Phone-first video profile for human calls. 540p is clear on a handset while
/// staying well below HD bandwidth; cellular starts at 360p.
Map<String, dynamic> avaVideoConstraints({required bool cellular}) => {
      'facingMode': 'user',
      'width': {'ideal': cellular ? 640 : 960, 'max': cellular ? 640 : 960},
      'height': {'ideal': cellular ? 360 : 540, 'max': cellular ? 360 : 540},
      'frameRate': {'ideal': cellular ? 24 : 30, 'max': 30},
    };

/// Sender-side video bitrate ceiling, defined HERE so it can never drift away
/// from the capture profile in [avaVideoConstraints] that it was chosen for.
/// 960x540@30 sits comfortably at 700-900 kbps; 640x360@24 at 350-500 kbps.
///
/// [degradeLevel] is the congestion ladder used by the QoS adapter: 0 is the
/// healthy ceiling, 1 is the thin-link step, 2 is "video is being switched off,
/// leave only enough for the last frames in flight".
///
/// Level 0 deliberately returns the SAME value the healthy path applies rather
/// than a separate constant. The pre-[CALL-MEDIA-540P-1] code hard-coded
/// 1_200_000 for the recovery step, so the first congestion-then-recovery cycle
/// of any call silently restored the old 1.2 Mbps cap and the new profile only
/// survived until the network hiccuped once.
int avaVideoMaxBitrateBps({required bool cellular, int degradeLevel = 0}) {
  if (degradeLevel >= 2) return 150000;
  if (degradeLevel == 1) return cellular ? 250000 : 400000;
  return cellular ? 450000 : 850000;
}

/// The `maxBitrate` to put on the AUDIO sender for a given Opus target.
///
/// RED (RFC 2198) is a WIRE-level wrapper: at [kOpusRedDistance] = 1 every
/// packet also carries the previous frame, so the RTP payload is about twice
/// the encoder's own rate. `RTCRtpEncoding.maxBitrate` bounds what leaves the
/// sender, redundancy included — so capping the sender at the Opus target while
/// RED is on squeezes the PRIMARY stream down to roughly half its target and
/// makes RED a net quality LOSS. Give the redundancy its own headroom instead.
int avaAudioSenderCapBps(int opusTargetBps, {required bool redActive}) =>
    redActive ? opusTargetBps * (kOpusRedDistance + 1) : opusTargetBps;

/// Tune the Opus encoder on a LOCAL SDP for voice — in-band FEC (packet-loss
/// resilience), DTX **OFF** ([CALL-AUDIO-DTX-1] 2026-08-03: DTX converts
/// "quiet talker / gated AEC" into digital silence the far end synthesises
/// over — continuous transmission is the right default for a voice product),
/// and a 40 kbps average-bitrate cap (enough FEC headroom without
/// starving primary audio). Only the opus `a=fmtp` line is rewritten;
/// everything else is untouched. No-op when no opus payload exists.
/// [CALL-SURVIVE-1 2026-08-04]: this is now the ONLY Opus tuner — the 1:1
/// path's private 40 kbps copy in call_session.dart was deleted (bitrate
/// regression, audit Finding 4).
String tuneOpusSdp(String? sdp, {bool enableRed = false}) {
  if (sdp == null || sdp.isEmpty) return sdp ?? '';
  final pts = RegExp(r'a=rtpmap:(\d+) opus/', caseSensitive: false)
      .allMatches(sdp)
      .map((m) => m.group(1)!)
      .toSet();
  if (pts.isEmpty) return sdp;
  const want = <String, String>{
    'useinbandfec': '1',
    'usedtx': '0',
    'maxaveragebitrate': _kOpusMaxAvgBitrate,
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
  if (enableRed) _applyOpusRed(lines, pts);
  return lines.join('\r\n');
}

/// Number of REDUNDANT Opus blocks carried alongside the primary, i.e. RFC-2198
/// "distance". 1 means each packet also carries the previous frame.
///
/// Deliberately 1, not 2. Distance 1 already covers the single-packet and
/// short-burst losses that dominate mobile links, and RED multiplies the
/// PAYLOAD: at [_kOpusMaxAvgBitrate] a distance of 1 roughly doubles the wire
/// rate and a distance of 2 roughly triples it. On the constrained links this
/// exists to protect, spending that much on redundancy is self-defeating —
/// congestion causes more loss than it prevents.
const int kOpusRedDistance = 1;

const String _kOpusMaxAvgBitrate = '40000';

/// [CALL-RED-1 2026-08-05] Actually turn RED on. Previously a no-op.
///
/// ## What was wrong
///
/// The prior implementation checked that a `red/48000` rtpmap existed and then
/// did NOTHING — the `if` body was an empty comment block. `callAudioRedExperimentV1`
/// was `true` in production and had been for days, `call_audio_red_negotiated`
/// was firing on every call, and RED was never once active on the wire. The
/// presence of an rtpmap is an offer of CAPABILITY, not use: libwebrtc lists
/// `red/48000` among the audio codecs but leaves Opus first on the m-line, so
/// the encoder never wraps anything.
///
/// ## What makes RED actually engage
///
/// Two edits, both required — either alone does nothing:
///
///  1. `a=fmtp:<redPt> <opusPt>/<opusPt>` — the RFC-2198 block list. Each entry
///     is one Opus payload type; N entries = N-1 redundant blocks + 1 primary.
///     Without this line the RED payload has no configured redundancy.
///  2. `<redPt>` must be FIRST in the `m=audio` payload list. RTP sends with the
///     first listed payload type; leave Opus first and RED is negotiated,
///     advertised, and unused — exactly the state we were in.
///
/// ## Why it stays capability-gated
///
/// We only ever REORDER a payload type the local description already contains.
/// Inventing an `a=rtpmap` for a codec the backend did not register would
/// advertise a payload the encoder cannot produce, and the far end would
/// receive undecodable audio — strictly worse than no RED. If a build omits
/// RFC-2198, this quietly does nothing and Opus in-band FEC remains the
/// baseline defence.
///
/// ## RED alongside in-band FEC
///
/// Both stay on, and that is intentional rather than an oversight. They cover
/// different failures: Opus in-band FEC only reacts once the DECODER reports
/// loss back to the encoder, so it is useless for the first burst and for
/// one-way loss, and it degrades the redundant copy to save bits. RED carries a
/// full-fidelity previous frame unconditionally. The redundancy critique is
/// real but applies to distance 2+; see [kOpusRedDistance].
void _applyOpusRed(List<String> lines, Set<String> opusPts) {
  // The m=audio line is the authority on which payload types are actually in
  // play and in what order — rtpmap lines can outlive an m-line edit.
  final mIdx = lines.indexWhere((l) => l.startsWith('m=audio '));
  if (mIdx < 0) return;
  final mParts = lines[mIdx].split(' ');
  if (mParts.length < 4) return; // m=audio <port> <proto> <pt>...
  final payloads = mParts.sublist(3);

  // RED payload type, from an rtpmap the local description already declares.
  String? redPt;
  for (final l in lines) {
    final m = RegExp(r'^a=rtpmap:(\d+) red/48000', caseSensitive: false).firstMatch(l);
    if (m != null && payloads.contains(m.group(1))) {
      redPt = m.group(1);
      break;
    }
  }
  if (redPt == null) return; // no RFC-2198 in this build — FEC only, silently.

  // Primary Opus PT: the first opus payload actually listed on the m-line, so
  // we agree with libwebrtc's own preference rather than picking arbitrarily
  // from a Set (whose iteration order is not the SDP order).
  String? opusPt;
  for (final p in payloads) {
    if (opusPts.contains(p)) {
      opusPt = p;
      break;
    }
  }
  if (opusPt == null) return;

  // 1. Redundancy block list. `<pt>/<pt>` = 1 redundant + 1 primary.
  final blocks = List<String>.filled(kOpusRedDistance + 1, opusPt).join('/');
  final redFmtp = 'a=fmtp:$redPt $blocks';
  final existing = lines.indexWhere((l) => l.startsWith('a=fmtp:$redPt '));
  if (existing >= 0) {
    lines[existing] = redFmtp;
  } else {
    // Place it directly after the RED rtpmap, where SDP readers expect it.
    final rtpmapIdx = lines.indexWhere(
        (l) => l.toLowerCase().startsWith('a=rtpmap:$redPt red/48000'));
    lines.insert(rtpmapIdx >= 0 ? rtpmapIdx + 1 : mIdx + 1, redFmtp);
  }

  // 2. Promote RED to the front of the payload list. This is the step that
  //    switches RED from "negotiated" to "in use".
  if (payloads.first != redPt) {
    final reordered = [redPt, ...payloads.where((p) => p != redPt)];
    lines[mIdx] = [...mParts.sublist(0, 3), ...reordered].join(' ');
  }
}

/// True when [sdp] has RED *actually engaged* — a red payload that is FIRST on
/// the m=audio line AND carries an `a=fmtp` block list.
///
/// Exists because the old telemetry asked the wrong question. It reported
/// `call_audio_red_negotiated` whenever a `red/48000` rtpmap appeared, which is
/// true on essentially every modern libwebrtc build whether or not RED does
/// anything — so the event read as success for days while RED was inert. Assert
/// the two conditions that make it real, and nothing else.
bool sdpHasActiveRed(String? sdp) {
  if (sdp == null || sdp.isEmpty) return false;
  final lines = sdp.split(RegExp(r'\r\n|\n'));
  final mIdx = lines.indexWhere((l) => l.startsWith('m=audio '));
  if (mIdx < 0) return false;
  final mParts = lines[mIdx].split(' ');
  if (mParts.length < 4) return false;
  final firstPt = mParts[3];
  final isRed = lines.any((l) =>
      l.toLowerCase().startsWith('a=rtpmap:$firstPt red/48000'));
  if (!isRed) return false;
  return lines.any((l) => l.startsWith('a=fmtp:$firstPt ') && l.contains('/'));
}
