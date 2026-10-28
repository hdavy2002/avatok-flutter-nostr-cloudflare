import 'dart:async';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/brand.dart';
import '../../data/api_exception.dart';
import '../../data/models/spaces.dart';
import '../../data/repos/spaces_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../booking_kit.dart';
import '../channel_kit.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-CREATOR-SPACES-1] Video KYC for Women-only and LGBTQ+ channels, native: WhatsApp check, Aadhaar code (DigiLocker on the website
/// as the fallback), the private declaration (LGBTQ+ customers), then a 10-second selfie video that reads a random code.
/// Route `/verify/space?lane=women|lgbtq[&creator=1]`. Pops `true` once the person is fully verified. Pending means "Under review".
///
/// The Aadhaar number is only held in a text field until the code is sent, then cleared; it is never logged or sent to telemetry.
class SpaceVerifyScreen extends StatefulWidget {
  const SpaceVerifyScreen({super.key, this.lane, this.creator = false, this.repo});

  /// Null = plain video KYC ([HF-CREATOR-BADGES-1]): Aadhaar and selfie only, no gender rule, declaration or join.
  final SpaceLane? lane;

  /// A creator starting a channel (role `host`, declaration already given when the path was chosen).
  final bool creator;
  final SpacesRepo? repo;

  @override
  State<SpaceVerifyScreen> createState() => _SpaceVerifyScreenState();
}

enum _Step { whatsapp, aadhaar, otp, wrongGender, declare, selfie, review, done }

class _SpaceVerifyScreenState extends State<SpaceVerifyScreen> {
  final _aadhaar = TextEditingController();
  final _otp = TextEditingController();
  SpaceStatus? _st;
  Object? _loadError;
  bool _loading = true;
  bool _busy = false;
  bool _otpSent = false;
  bool _fallback = false;
  bool _joined = false;
  bool _consent = false;
  bool _declare = false;
  bool _ack18 = false;
  String? _error;
  _Step? _lastStep;

  SpacesRepo get _repo => widget.repo ?? Services.instance.spacesRepo;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _aadhaar.dispose();
    _otp.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final st = widget.creator ? await _repo.creatorStatus() : await _repo.laneStatus();
      if (!mounted) return;
      setState(() {
        _st = st;
        _loading = false;
      });
      unawaited(_afterLoad(st));
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadError = e;
        _loading = false;
      });
    }
  }

  /// A customer's membership is recorded before the selfie is approved; do it once the Aadhaar (and declaration) are in.
  Future<void> _afterLoad(SpaceStatus st) async {
    if (widget.creator || _joined || widget.lane == null) return;
    if (widget.lane == SpaceLane.women && st.womenGranted) return; // [HF-INTRO-A2] already granted: nothing to join
    final s = _stepFor(st);
    if (s != _Step.selfie && s != _Step.review && s != _Step.done) return;
    try {
      await _repo.joinLane(widget.lane!);
      _joined = true;
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.userMessage);
    } catch (_) {
      // the server refuses at call time anyway
    }
  }

  _Step _stepFor(SpaceStatus st) {
    if (!st.whatsappVerified) return _Step.whatsapp;
    if (!st.aadhaarVerified) return _otpSent ? _Step.otp : _Step.aadhaar;
    if (widget.lane == SpaceLane.women && st.gender != 'F') return _Step.wrongGender;
    // [HF-INTRO-A2] A fan on the women's channel needs the Aadhaar only: once the server grants her (Aadhaar says Female) there is no selfie
    if (!widget.creator && widget.lane == SpaceLane.women && st.womenGranted) return _Step.done;
    if (!widget.creator && widget.lane == SpaceLane.lgbtq && !st.declared) return _Step.declare;
    if (st.selfie.approved) return _Step.done;
    if (st.selfie.pending) return _Step.review;
    return _Step.selfie;
  }

  String get _laneName => widget.lane?.name ?? 'kyc';

  void _track(_Step s) {
    if (_lastStep == s) return;
    _lastStep = s;
    Telemetry.event('hf_space_verify_step', {'lane': _laneName, 'step': s.name});
    if (s == _Step.done) Telemetry.event('hf_verify_badge_added', {'badge': 'video_kyc'}); // [HF-CREATOR-BADGES-1]
  }

  Future<void> _openWeb(String path) async {
    var ok = false;
    try {
      ok = await launchUrl(Uri.parse(Brand.url(path)), mode: LaunchMode.externalApplication);
    } catch (_) {
      ok = false;
    }
    if (!ok && mounted) toast(context, 'Could not open that page.');
  }

  String get _webPath => widget.creator ? '/hosts/onboarding?step=aadhaar' : '/verify/lane?lane=$_laneName';

  void _fail(Object e) {
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = e is ApiException ? e.userMessage : ApiException.genericText;
      if (e is ApiException && (e.extra['fallback'] == 'digilocker')) _fallback = true;
      if (e is ApiException && (e.code == 'no_otp' || e.code == 'otp_expired')) _otpSent = false;
    });
  }

  Future<void> _sendCode() async {
    if (_busy) return;
    final digits = _aadhaar.text.replaceAll(RegExp(r'\D'), '');
    if (digits.length != 12) {
      setState(() => _error = 'Type your 12-digit Aadhaar number.');
      return;
    }
    if (!_consent) {
      setState(() => _error = 'Please tick the box to agree.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final already = await _repo.aadhaarOtp(digits, role: widget.creator ? 'host' : 'lane_caller');
      _aadhaar.clear();
      if (!mounted) return;
      setState(() {
        _busy = false;
        _otpSent = !already;
      });
      if (already) await _load();
    } catch (e) {
      _fail(e);
    }
  }

  Future<void> _verifyOtp() async {
    if (_busy) return;
    final otp = _otp.text.replaceAll(RegExp(r'\D'), '');
    if (otp.length != 6) {
      setState(() => _error = 'Type the 6-digit code.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _repo.aadhaarVerify(otp);
      _otp.clear();
      if (!mounted) return;
      setState(() {
        _busy = false;
        _otpSent = false;
      });
      await _load();
    } catch (e) {
      _fail(e);
    }
  }

  Future<void> _submitDeclaration() async {
    if (_busy) return;
    if (!_declare || !_ack18) {
      setState(() => _error = 'Please tick both boxes to continue.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final lane = widget.lane;
      if (lane != null) await _repo.joinLane(lane);
      _joined = true;
      if (!mounted) return;
      setState(() => _busy = false);
      await _load();
    } catch (e) {
      _fail(e);
    }
  }

  void _finish() {
    if (context.canPop()) {
      context.pop(true);
    } else if (widget.creator) {
      context.go('/inf/home');
    } else {
      context.go('/reels');
    }
  }

  Widget _card(List<Widget> children) => Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(24), border: Border.all(color: C.line, width: 1.5)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
      );

  Widget _title(String text) => Text(text, style: t(24, color: C.maroon, w: FontWeight.w900, h: 1.15));

  Widget _body(String text) => Padding(padding: const EdgeInsets.only(top: 8), child: Text(text, style: t(16, color: C.muted, w: FontWeight.w700, h: 1.4)));

  Widget _check(bool value, String text, ValueChanged<bool> onChanged) => Padding(
        padding: const EdgeInsets.only(top: 10),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Checkbox(value: value, activeColor: C.maroon, onChanged: (v) => onChanged(v == true)),
          const SizedBox(width: 4),
          Expanded(child: Padding(padding: const EdgeInsets.only(top: 10), child: Text(text, style: t(16, w: FontWeight.w700, h: 1.35)))),
        ]),
      );

  Widget _errorLine() => _error == null ? const SizedBox.shrink() : Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: t(15, color: C.ruby, w: FontWeight.w800, h: 1.3)));

  Widget _chip(String label, bool done) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(color: done ? C.maroon : C.sand, borderRadius: BorderRadius.circular(999)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (done) ...[const Icon(Icons.check_rounded, size: 16, color: C.white), const SizedBox(width: 4)],
          Text(label, style: t(14, color: done ? C.white : C.muted, w: FontWeight.w900)),
        ]),
      );

  Widget _progress(SpaceStatus st) => Wrap(spacing: 8, runSpacing: 8, children: [
        _chip('WhatsApp', st.whatsappVerified),
        _chip('Aadhaar', st.aadhaarVerified),
        _chip('Video', st.selfie.approved),
      ]);

  Widget _fallbackButton() => Padding(
        padding: const EdgeInsets.only(top: 12),
        child: OutlinedButton(
          onPressed: () => unawaited(_openWeb(_webPath)),
          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52), side: const BorderSide(color: C.maroon, width: 1.5), shape: const StadiumBorder()),
          child: Text('Use DigiLocker on the website', style: t(16, color: C.maroon, w: FontWeight.w900)),
        ),
      );

  /// (content, bottom button or null)
  (List<Widget>, Widget?) _stepView(_Step s, SpaceStatus st) {
    switch (s) {
      case _Step.whatsapp:
        return (
          [
            _card([
              _title('Verify your WhatsApp first'),
              _body('Your WhatsApp number has to be verified before we can check your Aadhaar. Open the website to finish it, then come back and check again.'),
              _errorLine(),
              _fallbackButtonFor(_webPath, 'Open verification on the website'),
            ]),
          ],
          BookBottomButton(label: 'CHECK AGAIN', plum: true, icon: Icons.refresh_rounded, onTap: () => unawaited(_load())),
        );
      case _Step.aadhaar:
        return (
          [
            _card([
              _title('Your Aadhaar'),
              _body('We send a code to the mobile number linked to your Aadhaar. We keep only the last 4 digits of the number.'),
              const SizedBox(height: 14),
              DesiField(
                label: 'Aadhaar number',
                field: TextField(
                  controller: _aadhaar,
                  keyboardType: TextInputType.number,
                  maxLength: 14,
                  obscureText: true,
                  style: t(20, w: FontWeight.w800, ls: 0.1),
                  decoration: const InputDecoration(counterText: '', hintText: '12 digits'),
                ),
              ),
              _check(_consent, 'I agree to use my Aadhaar once to verify who I am, and I am 18 or older.', (v) => setState(() => _consent = v)),
              _errorLine(),
              if (_fallback) _fallbackButton(),
            ]),
          ],
          BookBottomButton(label: _busy ? 'PLEASE WAIT...' : 'SEND CODE', plum: true, enabled: !_busy, onTap: () => unawaited(_sendCode())),
        );
      case _Step.otp:
        return (
          [
            _card([
              _title('Type the Aadhaar code'),
              _body('We sent a 6-digit code to the mobile number linked to your Aadhaar.'),
              const SizedBox(height: 14),
              DesiField(
                label: '6-digit code',
                field: TextField(
                  controller: _otp,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  textAlign: TextAlign.center,
                  style: t(28, w: FontWeight.w900, ls: 0.4),
                  decoration: const InputDecoration(counterText: '', hintText: '------'),
                ),
              ),
              _errorLine(),
              if (_fallback) _fallbackButton(),
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: TextButton(
                  onPressed: () => setState(() {
                    _otpSent = false;
                    _error = null;
                  }),
                  child: Text('Start again', style: t(16, color: C.maroon, w: FontWeight.w900)),
                ),
              ),
            ]),
          ],
          BookBottomButton(label: _busy ? 'PLEASE WAIT...' : 'VERIFY', plum: true, enabled: !_busy, onTap: () => unawaited(_verifyOtp())),
        );
      case _Step.wrongGender:
        return (
          [
            _card([
              _title('This channel is for women'),
              _body('We are sorry. We could not match your Aadhaar record with a Women-only channel, so we cannot open it for you. If you think this is a mistake, write to ${Brand.supportEmail} and we will look at it.'),
            ]),
          ],
          BookBottomButton(label: 'BACK', plum: true, icon: Icons.arrow_back_rounded, onTap: () => context.canPop() ? context.pop(false) : context.go('/reels')),
        );
      case _Step.declare:
        return (
          [
            _card([
              _title('A private promise'),
              _body('This space is for LGBTQ+ members. What you tick stays private: it is never shown on your profile or to creators.'),
              _check(_declare, 'This space is right for me, and I will follow the LGBTQ+ space terms.', (v) => setState(() => _declare = v)),
              _check(_ack18, 'I am 18 or older.', (v) => setState(() => _ack18 = v)),
              _errorLine(),
            ]),
          ],
          BookBottomButton(label: _busy ? 'PLEASE WAIT...' : 'CONTINUE', plum: true, enabled: !_busy, onTap: () => unawaited(_submitDeclaration())),
        );
      case _Step.selfie:
        return (
          [
            if (st.selfie.rejected)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: _card([
                  _title('Please record again'),
                  _body(st.selfie.reason ?? 'We could not match your video. Record it again in good light, with your face clear.'),
                ]),
              ),
            _SelfieStep(repo: _repo, onUploaded: () => unawaited(_load())),
          ],
          null,
        );
      case _Step.review:
        return (
          [
            _card([
              _title('Under review'),
              _body('We got your video. Our team compares it with your Aadhaar photo, usually within a day. We will WhatsApp you when it is done.'),
            ]),
          ],
          BookBottomButton(label: 'CHECK AGAIN', plum: true, icon: Icons.refresh_rounded, onTap: () => unawaited(_load())),
        );
      case _Step.done:
        return (
          [
            _card([
              Row(children: [const VerifiedTick(), const SizedBox(width: 12), Expanded(child: _title('You are verified'))]),
              _body(widget.creator
                  ? (widget.lane == null ? 'Your video KYC is done. You can go live once the rest of your details are in.' : 'Your channel can now go live once the rest of your details are in.')
                  : (widget.lane == null ? 'You can now call, book and join the queue with creators who only take video-KYC callers.' : 'You can now call, book and join the queue on this channel.')),
            ]),
          ],
          BookBottomButton(label: widget.creator ? 'CONTINUE' : (widget.lane == null ? 'DONE' : 'BACK TO THE CHANNEL'), plum: true, onTap: _finish),
        );
    }
  }

  Widget _fallbackButtonFor(String path, String label) => Padding(
        padding: const EdgeInsets.only(top: 12),
        child: OutlinedButton(
          onPressed: () => unawaited(_openWeb(path)),
          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52), side: const BorderSide(color: C.maroon, width: 1.5), shape: const StadiumBorder()),
          child: Text(label, style: t(16, color: C.maroon, w: FontWeight.w900)),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final st = _st;
    Widget content;
    Widget? bottom;
    if (_loading && st == null) {
      content = const Center(child: CircularProgressIndicator(color: C.maroon));
    } else if (st == null) {
      final e = _loadError;
      content = ListView(padding: const EdgeInsets.all(16), children: [
        _card([
          _title(e is ApiException ? e.failureTitle : 'That did not work'),
          _body(e is ApiException ? e.failureMessage : ApiException.genericText),
        ]),
      ]);
      bottom = BookBottomButton(label: 'TRY AGAIN', plum: true, icon: Icons.refresh_rounded, onTap: () => unawaited(_load()));
    } else {
      final step = _stepFor(st);
      _track(step);
      final (children, btn) = _stepView(step, st);
      bottom = btn;
      content = ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          Text((widget.lane?.tagText ?? 'Video KYC').toUpperCase(), style: t(14, color: C.tan, w: FontWeight.w900, ls: 0.08)),
          const SizedBox(height: 10),
          _progress(st),
          const SizedBox(height: 14),
          ...children,
        ],
      );
    }
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(children: [
          ChannelHeader(widget.creator ? (widget.lane == null ? 'Video KYC' : 'Verify your channel') : 'Verify to call'),
          Expanded(child: content),
          if (bottom != null) bottom,
        ]),
      ),
    );
  }
}

/// A round tick for the "verified" card (plain maroon, not the green badge colour).
class VerifiedTick extends StatelessWidget {
  const VerifiedTick({super.key});

  @override
  Widget build(BuildContext context) => Container(
        width: 44,
        height: 44,
        decoration: const BoxDecoration(color: C.maroon, shape: BoxShape.circle),
        child: const Icon(Icons.check_rounded, color: C.white, size: 28),
      );
}

/// The selfie video step: fetch a random code, open the front camera, record 10 seconds with the code on screen, upload.
class _SelfieStep extends StatefulWidget {
  const _SelfieStep({required this.repo, required this.onUploaded});

  final SpacesRepo repo;
  final VoidCallback onUploaded;

  @override
  State<_SelfieStep> createState() => _SelfieStepState();
}

class _SelfieStepState extends State<_SelfieStep> {
  CameraController? _cam;
  String? _code;
  bool _starting = false;
  bool _recording = false;
  bool _uploading = false;
  bool _denied = false;
  int _left = 10;
  Timer? _tick;
  String? _error;

  @override
  void dispose() {
    _tick?.cancel();
    unawaited(_cam?.dispose());
    super.dispose();
  }

  Future<void> _prepare() async {
    if (_starting) return;
    setState(() {
      _starting = true;
      _error = null;
      _denied = false;
    });
    try {
      final code = await widget.repo.selfieCode();
      final cams = await availableCameras();
      if (cams.isEmpty) {
        if (mounted) setState(() {
          _starting = false;
          _error = 'We could not find a camera on this phone.';
        });
        return;
      }
      final cam = cams.firstWhere((c) => c.lensDirection == CameraLensDirection.front, orElse: () => cams.first);
      final ctl = CameraController(cam, ResolutionPreset.medium, enableAudio: true);
      await ctl.initialize();
      if (!mounted) {
        await ctl.dispose();
        return;
      }
      setState(() {
        _code = code;
        _cam = ctl;
        _starting = false;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() {
        _starting = false;
        _error = e.userMessage;
      });
    } on CameraException {
      if (mounted) setState(() {
        _starting = false;
        _denied = true;
        _error = 'We need your camera and microphone for this short video. Please allow them in Settings.';
      });
    } catch (_) {
      if (mounted) setState(() {
        _starting = false;
        _error = 'We could not start the camera. Please try again.';
      });
    }
  }

  Future<void> _record() async {
    final c = _cam;
    if (c == null || _recording || _uploading) return;
    try {
      await c.startVideoRecording();
    } catch (_) {
      if (mounted) setState(() => _error = 'We could not start recording. Please try again.');
      return;
    }
    if (!mounted) return;
    setState(() {
      _recording = true;
      _error = null;
      _left = 10;
    });
    _tick = Timer.periodic(const Duration(seconds: 1), (tm) {
      if (!mounted) {
        tm.cancel();
        return;
      }
      setState(() => _left -= 1);
      if (_left <= 0) {
        tm.cancel();
        unawaited(_stop());
      }
    });
  }

  Future<void> _stop() async {
    final c = _cam;
    final code = _code;
    if (c == null || code == null) return;
    _tick?.cancel();
    final file = await (() async {
      try {
        return await c.stopVideoRecording();
      } catch (_) {
        return null;
      }
    })();
    if (!mounted) return;
    if (file == null) {
      setState(() {
        _recording = false;
        _error = 'The video did not save. Please try again.';
      });
      return;
    }
    setState(() {
      _recording = false;
      _uploading = true;
    });
    try {
      final bytes = await file.readAsBytes();
      await widget.repo.uploadSelfie(bytes, code: code);
      if (!mounted) return;
      widget.onUploaded();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _uploading = false;
        _error = e is ApiException ? e.userMessage : ApiException.genericText;
        _code = null; // the old code may have expired; a fresh one is fetched on retry
      });
    }
  }

  /// After a failed upload: new code, same camera.
  Future<void> _retry() async {
    try {
      final code = await widget.repo.selfieCode();
      if (!mounted) return;
      setState(() {
        _code = code;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e is ApiException ? e.userMessage : ApiException.genericText);
    }
  }

  Widget _box(List<Widget> children) => Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(24), border: Border.all(color: C.line, width: 1.5)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
      );

  @override
  Widget build(BuildContext context) {
    final cam = _cam;
    final err = _error == null ? null : Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: t(15, color: C.ruby, w: FontWeight.w800, h: 1.3)));
    if (cam == null || !cam.value.isInitialized) {
      return _box([
        Text('A 10-second video', style: t(24, color: C.maroon, w: FontWeight.w900, h: 1.15)),
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text(
            'We show you a 6-digit code. Hold the phone at face height, in good light, and read the code out loud while we record. Our team compares your face with your Aadhaar photo. Only you and our team see it.',
            style: t(16, color: C.muted, w: FontWeight.w700, h: 1.4),
          ),
        ),
        if (err != null) err,
        const SizedBox(height: 16),
        BookBottomButton(label: _starting ? 'OPENING CAMERA...' : 'OPEN CAMERA', plum: true, enabled: !_starting, icon: Icons.videocam_rounded, padding: EdgeInsets.zero, onTap: () => unawaited(_prepare())),
        if (_denied)
          TextButton(onPressed: () => unawaited(openAppSettings()), child: Text('Open Settings', style: t(16, color: C.maroon, w: FontWeight.w900))),
      ]);
    }
    final size = cam.value.previewSize;
    return _box([
      Text(_code == null ? 'Get a new code' : 'Read this code out loud', style: t(18, color: C.muted, w: FontWeight.w800), textAlign: TextAlign.center),
      const SizedBox(height: 6),
      Text(_code ?? '------', textAlign: TextAlign.center, style: t(54, color: C.maroon, w: FontWeight.w900, ls: 0.12, h: 1.05)),
      const SizedBox(height: 12),
      ClipRRect(
        borderRadius: BorderRadius.circular(28),
        child: AspectRatio(
          aspectRatio: 3 / 4,
          child: size == null
              ? CameraPreview(cam)
              : FittedBox(fit: BoxFit.cover, clipBehavior: Clip.hardEdge, child: SizedBox(width: size.height, height: size.width, child: CameraPreview(cam))),
        ),
      ),
      if (err != null) err,
      const SizedBox(height: 14),
      if (_uploading)
        Center(child: Text('Sending your video...', style: t(17, color: C.maroon, w: FontWeight.w900)))
      else if (_recording)
        Center(child: Text('Recording... $_left', style: t(20, color: C.ruby, w: FontWeight.w900)))
      else if (_code == null)
        BookBottomButton(label: 'GET A NEW CODE', plum: true, icon: Icons.refresh_rounded, padding: EdgeInsets.zero, onTap: () => unawaited(_retry()))
      else
        BookBottomButton(label: 'RECORD 10 SECONDS', plum: true, icon: Icons.fiber_manual_record_rounded, padding: EdgeInsets.zero, onTap: () => unawaited(_record())),
    ]);
  }
}
