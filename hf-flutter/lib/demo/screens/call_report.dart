import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/api_exception.dart';
import '../../data/repos/call_safety_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../call_safety_kit.dart';
import '../desi.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-CALL-SAFETY-APP] "How was the call?" (artboard AppPostCall), shown after a call that connected, while recording is on:
/// plum "CALL ENDED" hero, Good / Something was wrong, the four reasons, Send report (`POST /api/hf/calls/:callId/report`).
/// Pops with `true` once a report was sent (or Good was tapped) and with `null` when she leaves it.
class PostCallReportScreen extends StatefulWidget {
  const PostCallReportScreen({super.key, required this.callId, required this.name, this.minutes, this.paid, this.repo});

  final String callId;
  final String name;

  /// Talked minutes, or null when unknown.
  final int? minutes;

  /// "₹168", or null when unknown.
  final String? paid;
  final CallSafetyRepo? repo;

  @override
  State<PostCallReportScreen> createState() => _PostCallReportScreenState();
}

class _PostCallReportScreenState extends State<PostCallReportScreen> {
  bool _wrong = false;
  bool _busy = false;
  String? _error;
  final Set<String> _picked = <String>{};

  CallSafetyRepo get _repo => widget.repo ?? Services.instance.callSafetyRepo;
  String get _first => widget.name.trim().split(' ').first;

  @override
  void initState() {
    super.initState();
    Telemetry.event('hf_safety_view', {'surface': 'post_call'});
  }

  void _good() {
    Telemetry.event('hf_call_report_good');
    Navigator.of(context).pop(true);
  }

  Future<void> _send() async {
    if (_busy || _picked.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final reasons = [for (final r in kCallReportReasons) if (_picked.contains(r.key)) r.key];
    try {
      await _repo.reportCall(widget.callId, reasons);
      Telemetry.event('hf_call_report_sent', {'outcome': 'ok', 'reasons': reasons, 'n': reasons.length});
      if (!mounted) return;
      toast(context, 'Thank you. A person will check it.');
      Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      Telemetry.event('hf_call_report_sent', {'outcome': 'failed', 'reasons': reasons, 'n': reasons.length, 'reason': e.code});
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.userMessage;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = ApiException.genericText;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final who = _first.isEmpty ? 'The other person' : _first;
    final label = widget.name.trim().isEmpty ? 'Your call' : widget.name;
    final title = widget.minutes == null ? label : '$label · ${widget.minutes} min';
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(children: [
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
              children: [
                DesiHero(
                  eyebrow: 'Call ended',
                  title: title,
                  sub: widget.paid == null ? null : '${widget.paid} from your wallet',
                  ghost: 'Shukriya',
                  tone: DesiTone.plum,
                  minHeight: 170,
                ),
                const SizedBox(height: 12),
                DesiCard(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const DesiTitle('How was the call?'),
                    const SizedBox(height: 12),
                    Row(children: [
                      Expanded(
                        flex: 10,
                        child: _choice('Good', on: false, good: true, onTap: _busy ? null : _good),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        flex: 14,
                        child: _choice('Something was wrong', on: _wrong, good: false, onTap: _busy ? null : () => setState(() => _wrong = !_wrong)),
                      ),
                    ]),
                  ]),
                ),
                if (_wrong) ...[
                  const SizedBox(height: 12),
                  DesiCard(
                    tone: DesiTone.rani,
                    corner: DesiCorner.hibiscus,
                    padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
                    child: Column(children: [
                      for (var i = 0; i < kCallReportReasons.length; i++)
                        Container(
                          decoration: BoxDecoration(border: i == kCallReportReasons.length - 1 ? null : const Border(bottom: BorderSide(color: C.line))),
                          child: SafetyTick(
                            label: kCallReportReasons[i].label,
                            textSize: 16,
                            minHeight: 52,
                            on: _picked.contains(kCallReportReasons[i].key),
                            onTap: _busy
                                ? null
                                : () => setState(() {
                                      final k = kCallReportReasons[i].key;
                                      if (!_picked.remove(k)) _picked.add(k);
                                    }),
                          ),
                        ),
                    ]),
                  ),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Semantics(liveRegion: true, child: Text(_error!, style: t(14, color: C.ruby, w: FontWeight.w800, h: 1.35))),
                ],
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 4, 14, 14),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              if (_wrong) ...[
                SafetyButton('Send report', busy: _busy, onTap: _picked.isEmpty ? null : () => unawaited(_send())),
                const SizedBox(height: 8),
                Text("A person checks it. $who won't see who reported.", textAlign: TextAlign.center, style: t(14, color: C.muted, w: FontWeight.w600)),
              ] else
                SafetyButton('Skip', ghost: true, onTap: _busy ? null : () => Navigator.of(context).pop()),
            ]),
          ),
        ]),
      ),
    );
  }

  /// Good (pale green, the one allowed green tokens) and Something was wrong (plum, white text when chosen). 52 dp tall.
  Widget _choice(String label, {required bool on, required bool good, required VoidCallback? onTap}) {
    final bg = good ? C.onlineBg : (on ? C.maroon : C.white);
    final fg = good ? C.onlineInk : (on ? C.white : C.maroon);
    final edge = good ? C.onlineLine : (on ? C.maroon : C.line);
    return Semantics(
      button: true,
      selected: on,
      label: label,
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: bg,
        shape: StadiumBorder(side: BorderSide(color: edge, width: 2)),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: onTap,
          child: SizedBox(height: 52, child: Center(child: Text(label, textAlign: TextAlign.center, style: t(16, color: fg, w: FontWeight.w800)))),
        ),
      ),
    );
  }
}
