import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/api_exception.dart';
import '../../data/models/merch.dart';
import '../../data/repos/merch_repo.dart';
import '../../ui/net_image.dart';
import '../desi.dart';
import '../merch_designer/contract.dart';
import '../merch_kit.dart';
import '../theme.dart';
import '../widgets.dart';

/// Asked once per app run: "the money is taken from your paid wallet money" (owner D2).
bool _aiConfirmedThisRun = false;

const List<String> _examples = [
  'Lord Ganesha in Madhubani style',
  'A royal peacock with flowers',
  'Cricket fan with the tricolour',
  'Truck art: "Horn OK Please"',
  'Chai cup with a smile',
  'Namaste in Hindi lettering',
];

const List<(String, String)> _aspects = [('1:1', 'Square 1:1'), ('3:4', 'Portrait 3:4'), ('4:3', 'Landscape 4:3')];

const List<String> _waitLines = [
  'Mixing the colours…',
  'Sketching your idea…',
  'Adding an Indian touch…',
  'Filling in the details…',
  'Almost there…',
];

/// [HF-MERCH-STUDIO-2] "Create with AI": a tall sheet. Reference pictures, a prompt, a style, the cost, then the result with
/// "Use this", "Change this" and "Remove background". The wizard keeps the tray; this sheet reports through the callbacks.
Future<void> showMerchAiSheet(
  BuildContext context, {
  required MerchRepo repo,
  required AiInfo info,
  required List<StudioArt> tray,
  required Future<StudioArt?> Function() pickReference,
  required ValueChanged<StudioArt> onArt,
  required ValueChanged<StudioArt> onUse,
  required VoidCallback onRefsUsed,
  required Future<void> Function() onAddMoney,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    enableDrag: false,
    backgroundColor: C.paper,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
    builder: (ctx) {
      final mq = MediaQuery.of(ctx);
      final inset = mq.viewInsets.bottom;
      final h = ((mq.size.height - inset) * 0.9).clamp(320.0, 2000.0).toDouble();
      return Padding(
        padding: EdgeInsets.only(bottom: inset),
        child: SizedBox(
          height: h,
          child: MerchAiSheet(
            repo: repo,
            info: info,
            tray: tray,
            pickReference: pickReference,
            onArt: onArt,
            onUse: onUse,
            onRefsUsed: onRefsUsed,
            onAddMoney: onAddMoney,
          ),
        ),
      );
    },
  );
}

class MerchAiSheet extends StatefulWidget {
  const MerchAiSheet({
    super.key,
    required this.repo,
    required this.info,
    required this.tray,
    required this.pickReference,
    required this.onArt,
    required this.onUse,
    required this.onRefsUsed,
    required this.onAddMoney,
  });

  final MerchRepo repo;
  final AiInfo info;
  final List<StudioArt> tray;
  final Future<StudioArt?> Function() pickReference;
  final ValueChanged<StudioArt> onArt;
  final ValueChanged<StudioArt> onUse;
  final VoidCallback onRefsUsed;
  final Future<void> Function() onAddMoney;

  @override
  State<MerchAiSheet> createState() => _MerchAiSheetState();
}

class _MerchAiSheetState extends State<MerchAiSheet> with SingleTickerProviderStateMixin {
  late AiInfo _info = widget.info;
  late final List<StudioArt> _tray = List<StudioArt>.of(widget.tray);
  final List<String> _refs = <String>[];
  final TextEditingController _prompt = TextEditingController();
  late final AnimationController _spin = AnimationController(vsync: this, duration: const Duration(seconds: 6));
  Timer? _lines;

  String? _style;
  String _aspect = '1:1';
  bool _plain = true;
  bool _working = false;
  bool _bgBusy = false;
  bool _pickBusy = false;
  int _line = 0;
  String? _error;
  StudioArt? _result;
  String? _baseArtId;
  String _lastPrompt = '';

  @override
  void dispose() {
    _lines?.cancel();
    _spin.dispose();
    _prompt.dispose();
    super.dispose();
  }

  int get _charge => _info.chargePaise;
  int get _short => _charge > _info.balancePaise ? _charge - _info.balancePaise : 0;
  bool get _promptOk => _prompt.text.trim().length >= 3;
  bool get _canGenerate => !_working && !_bgBusy && _promptOk && _short == 0;

  // ---------------------------------------------------------------------------------------------- actions

  Future<void> _refreshInfo() async {
    try {
      final i = await widget.repo.aiInfo();
      if (mounted) setState(() => _info = i);
    } catch (_) {
      // keep the numbers we have
    }
  }

  Future<void> _addMoney() async {
    merchEvent('merch_ai', {'action': 'add_money'});
    await widget.onAddMoney();
    if (mounted) await _refreshInfo();
  }

  Future<void> _newReference() async {
    if (_pickBusy || _working) return;
    setState(() => _pickBusy = true);
    StudioArt? picked;
    try {
      picked = await widget.pickReference();
    } finally {
      if (mounted) setState(() => _pickBusy = false);
    }
    final art = picked;
    if (art == null || !mounted) return;
    setState(() {
      _tray.add(art);
      if (_refs.length < 3) _refs.add(art.artId);
    });
  }

  void _toggleRef(StudioArt a) {
    setState(() {
      if (_refs.contains(a.artId)) {
        _refs.remove(a.artId);
      } else if (_refs.length < 3) {
        _refs.add(a.artId);
      } else {
        toast(context, 'You can use up to 3 pictures.');
      }
    });
  }

  void _startLines() {
    _line = 0;
    _spin.repeat();
    _lines?.cancel();
    _lines = Timer.periodic(const Duration(seconds: 4), (_) {
      if (mounted) setState(() => _line = (_line + 1) % _waitLines.length);
    });
  }

  void _stopLines() {
    _lines?.cancel();
    _lines = null;
    _spin.stop();
  }

  Future<void> _generate() async {
    if (!_canGenerate) return;
    if (!_aiConfirmedThisRun) {
      final ok = await hfConfirm(
        context,
        title: 'Make this picture?',
        body: '${merchRupees(_charge)} will be taken from your paid wallet money. If the picture can’t be made, you get it back.',
        confirmLabel: 'Yes, make it',
        cancelLabel: 'Not now',
      );
      if (!ok || !mounted) {
        merchEvent('merch_ai', {'action': 'confirm_declined'});
        return;
      }
      _aiConfirmedThisRun = true;
    }
    final prompt = _prompt.text.trim();
    final base = _baseArtId;
    final refs = List<String>.of(_refs);
    setState(() {
      _working = true;
      _error = null;
      _result = null;
    });
    _startLines();
    merchEvent('merch_ai', {'action': 'generate_started', 'refs': refs.length, 'style': _style ?? 'none', 'edit': base != null, 'aspect': _aspect});
    if (refs.isNotEmpty) widget.onRefsUsed();
    try {
      final r = await widget.repo.generateAi(
        requestKey: MerchRepo.newRequestKey(),
        prompt: prompt,
        style: _style,
        refArtIds: refs,
        baseArtId: base,
        plainBackground: _plain,
        aspect: _aspect,
      );
      final art = StudioArt(art: r.art, source: 'ai', label: prompt);
      widget.onArt(art);
      merchEvent('merch_ai', {'action': 'generate_done', 'edit': base != null});
      if (!mounted) return;
      _stopLines();
      setState(() {
        _working = false;
        _result = art;
        _lastPrompt = prompt;
        _baseArtId = null;
        _tray.insert(0, art);
        _info = AiInfo(
          enabled: _info.enabled,
          chargePaise: _info.chargePaise,
          balancePaise: r.balancePaise,
          testCreditPaise: _info.testCreditPaise,
          canAfford: r.balancePaise >= _info.chargePaise,
          recent: _info.recent,
        );
      });
    } on ApiException catch (e) {
      _stopLines();
      merchEvent('merch_ai', {'action': 'generate_failed', 'code': e.code});
      if (!mounted) return;
      _onGenerateError(e);
    } catch (e, st) {
      _stopLines();
      merchCapture(e, st, 'ai_generate');
      if (mounted) {
        setState(() {
          _working = false;
          _error = 'Something went wrong. If money was taken, it will come back to your wallet. Please try again.';
        });
      }
    }
  }

  void _onGenerateError(ApiException e) {
    switch (e.code) {
      case 'insufficient_funds':
        final bal = e.extra['balancePaise'];
        final short = e.extra['shortPaise'];
        setState(() {
          _working = false;
          if (bal is num) {
            _info = AiInfo(
              enabled: _info.enabled,
              chargePaise: _info.chargePaise,
              balancePaise: bal.round(),
              testCreditPaise: _info.testCreditPaise,
              canAfford: false,
              recent: _info.recent,
            );
          }
          final need = short is num ? short.round() : _short;
          _error = need > 0 ? 'You need ${merchRupees(need)} more paid wallet money to make this picture.' : 'Your paid wallet money is not enough for this picture.';
        });
      case 'prompt_blocked':
        setState(() {
          _working = false;
          _error = 'We can’t make that picture. Try different words. You were not charged.';
        });
      case 'art_blocked':
      case 'generation_failed':
        final own = e.message;
        setState(() {
          _working = false;
          _error = '${own != null && own.isNotEmpty ? own : 'The picture could not be made.'} Your money was given back.';
        });
        unawaited(_refreshInfo());
      case 'ai_off':
        final messenger = ScaffoldMessenger.maybeOf(context);
        Navigator.of(context).pop();
        messenger?.showSnackBar(const SnackBar(content: Text('AI pictures are switched off right now.')));
      default:
        setState(() {
          _working = false;
          _error = e.userMessage;
        });
        unawaited(_refreshInfo());
    }
  }

  Future<void> _removeBackground() async {
    final cur = _result;
    if (cur == null || _bgBusy) return;
    setState(() {
      _bgBusy = true;
      _error = null;
    });
    try {
      final up = await widget.repo.removeBackground(cur.artId);
      final art = StudioArt(art: up, source: 'bg_removed', label: cur.label);
      widget.onArt(art);
      merchEvent('merch_ai', {'action': 'bg_removed'});
      if (mounted) {
        setState(() {
          _bgBusy = false;
          _result = art;
          _tray.insert(0, art);
        });
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _bgBusy = false;
          _error = e.userMessage;
        });
      }
    } catch (e, st) {
      merchCapture(e, st, 'bg_remove');
      if (mounted) {
        setState(() {
          _bgBusy = false;
          _error = 'Could not remove the background. Please try again.';
        });
      }
    }
  }

  void _useResult() {
    final r = _result;
    if (r == null) return;
    merchEvent('merch_ai', {'action': 'use'});
    widget.onUse(r);
    Navigator.of(context).pop();
  }

  void _changeResult() {
    final r = _result;
    if (r == null) return;
    setState(() {
      _baseArtId = r.artId;
      _prompt.text = _lastPrompt;
      _prompt.selection = TextSelection.collapsed(offset: _prompt.text.length);
      _result = null;
      _error = null;
    });
    merchEvent('merch_ai', {'action': 'change_started'});
  }

  // ---------------------------------------------------------------------------------------------- build

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !_working,
      child: Column(children: [
        const SizedBox(height: 10),
        Center(child: Container(width: 44, height: 5, decoration: BoxDecoration(color: C.brass, borderRadius: BorderRadius.circular(3)))),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 6, 8, 0),
          child: Row(children: [
            const Icon(Icons.auto_awesome_rounded, color: C.marigold, size: 26),
            const SizedBox(width: 10),
            Expanded(child: Semantics(header: true, child: Text('Create with AI', style: t(22, color: C.maroon)))),
            Semantics(
              button: true,
              label: 'Close',
              child: IconButton(
                iconSize: 28,
                constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
                onPressed: _working ? null : () => Navigator.of(context).pop(),
                icon: const Icon(Icons.close_rounded, color: C.deep),
              ),
            ),
          ]),
        ),
        Expanded(child: _working ? _workingView() : (_result != null ? _resultView(_result!) : _formView())),
        _bottom(),
      ]),
    );
  }

  Widget _formView() {
    final baseId = _baseArtId;
    final base = baseId == null ? null : _tray.where((a) => a.artId == baseId).firstOrNull;
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
      children: [
        if (base != null)
          Container(
            margin: const EdgeInsets.only(bottom: 14),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: C.lavtint, borderRadius: BorderRadius.circular(20)),
            child: Row(children: [
              MerchArtThumb(base, size: 64),
              const SizedBox(width: 12),
              Expanded(child: Text('Changing this picture. Say what to change.', style: t(15, w: FontWeight.w700))),
              TextButton(
                onPressed: () => setState(() => _baseArtId = null),
                style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                child: Text('Start fresh', style: t(15, color: C.maroon)),
              ),
            ]),
          ),
        Text('What should the picture show?', style: t(16, color: C.maroon)),
        const SizedBox(height: 8),
        TextField(
          controller: _prompt,
          minLines: 3,
          maxLines: 5,
          maxLength: 800,
          textCapitalization: TextCapitalization.sentences,
          onChanged: (_) => setState(() => _error = null),
          style: t(17, w: FontWeight.w700),
          decoration: const InputDecoration(hintText: 'Example: Lord Ganesha in Madhubani style', counterText: ''),
        ),
        const SizedBox(height: 10),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final e in _examples)
            MerchPill(
              label: e,
              selected: false,
              onTap: () => setState(() {
                _prompt.text = e;
                _prompt.selection = TextSelection.collapsed(offset: e.length);
                _error = null;
              }),
            ),
        ]),
        const SizedBox(height: 18),
        Text('Pictures to copy from (optional, up to 3)', style: t(16, color: C.maroon)),
        const SizedBox(height: 2),
        Text('The AI uses them as a guide, for example your photo or your own drawing.', style: t(14, color: C.muted, w: FontWeight.w600)),
        SizedBox(
          height: 104,
          child: ListView(scrollDirection: Axis.horizontal, clipBehavior: Clip.none, padding: const EdgeInsets.symmetric(vertical: 10), children: [
            _newTile(),
            for (final a in _tray) ...[
              const SizedBox(width: 10),
              MerchArtThumb(a, size: 84, selected: _refs.contains(a.artId), onTap: () => _toggleRef(a), semanticLabel: 'Picture to copy from'),
            ],
          ]),
        ),
        const SizedBox(height: 10),
        Text('Style (optional)', style: t(16, color: C.maroon)),
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final s in merchAiStyles) MerchPill(label: s.$2, selected: _style == s.$1, onTap: () => setState(() => _style = _style == s.$1 ? null : s.$1)),
        ]),
        const SizedBox(height: 18),
        Text('Shape', style: t(16, color: C.maroon)),
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final a in _aspects) MerchPill(label: a.$2, selected: _aspect == a.$1, onTap: () => setState(() => _aspect = a.$1)),
        ]),
        const SizedBox(height: 8),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _plain,
          onChanged: (v) => setState(() => _plain = v),
          title: Text('Plain background (best for printing)', style: t(16, w: FontWeight.w700)),
        ),
        if (_error != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_error!, style: t(15, color: C.ruby, w: FontWeight.w700))),
      ],
    );
  }

  Widget _newTile() {
    return Semantics(
      button: true,
      label: 'Add a new picture to copy from',
      child: Material(
        color: C.lavtint,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: const BorderSide(color: C.brass, width: 1.5)),
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: _pickBusy ? null : () => unawaited(_newReference()),
          child: SizedBox(
            width: 84,
            height: 84,
            child: _pickBusy
                ? const Center(child: SizedBox(width: 28, height: 28, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 3)))
                : Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                    const Icon(Icons.add_photo_alternate_rounded, size: 30, color: C.maroon),
                    Text('New', style: t(14, color: C.maroon)),
                  ]),
          ),
        ),
      ),
    );
  }

  Widget _workingView() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          RotationTransition(turns: _spin, child: const Marigold(size: 96)),
          const SizedBox(height: 22),
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 300),
            child: Text(_waitLines[_line], key: ValueKey<int>(_line), textAlign: TextAlign.center, style: t(20, color: C.maroon)),
          ),
          const SizedBox(height: 10),
          Text('This can take up to a minute. Please stay here.', textAlign: TextAlign.center, style: t(15, color: C.muted, w: FontWeight.w700)),
        ]),
      ),
    );
  }

  Widget _resultView(StudioArt r) {
    final ratio = r.art.width > 0 && r.art.height > 0 ? (r.art.width / r.art.height).clamp(0.6, 1.6).toDouble() : 1.0;
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 6, 20, 16),
      children: [
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 340),
            child: AspectRatio(
              aspectRatio: ratio,
              child: Container(
                decoration: BoxDecoration(
                  gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.lavtint, C.blush]),
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: C.line),
                ),
                clipBehavior: Clip.antiAlias,
                padding: const EdgeInsets.all(8),
                child: _bgBusy
                    ? const Center(child: CircularProgressIndicator(color: C.maroon))
                    : NetImage(r.art.url, fit: BoxFit.contain, fallback: const Center(child: CircularProgressIndicator(color: C.maroon, strokeWidth: 3))),
              ),
            ),
          ),
        ),
        const SizedBox(height: 14),
        Text(_bgBusy ? 'Taking the background out…' : 'Your picture is ready', textAlign: TextAlign.center, style: t(18, color: C.maroon)),
        for (final w in r.art.warnings) MerchNote(w),
        const SizedBox(height: 14),
        DesiButton('Use this', icon: Icons.check_rounded, kind: DesiButtonKind.rani, expand: true, onTap: _bgBusy ? null : _useResult),
        const SizedBox(height: 10),
        DesiButton(
          'Change this · ${merchRupees(_charge)}',
          icon: Icons.edit_rounded,
          kind: DesiButtonKind.ghost,
          expand: true,
          onTap: _bgBusy ? null : _changeResult,
        ),
        const SizedBox(height: 10),
        DesiButton('Remove background · free', icon: Icons.content_cut_rounded, kind: DesiButtonKind.ghost, expand: true, onTap: _bgBusy ? null : () => unawaited(_removeBackground())),
        const SizedBox(height: 10),
        DesiButton(
          'Make a different picture',
          kind: DesiButtonKind.ghost,
          expand: true,
          onTap: _bgBusy
              ? null
              : () => setState(() {
                    _result = null;
                    _baseArtId = null;
                    _error = null;
                  }),
        ),
        if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: t(15, color: C.ruby, w: FontWeight.w700))),
      ],
    );
  }

  /// The cost card is always on screen (owner D2), with the button under it while the form is open.
  Widget _bottom() {
    final showButton = !_working && _result == null;
    final short = _short;
    final free = _charge <= 0;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
      decoration: const BoxDecoration(color: C.paper, border: Border(top: BorderSide(color: C.line))),
      child: SafeArea(
        top: false,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Container(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
            decoration: BoxDecoration(color: C.goldtint, borderRadius: BorderRadius.circular(18), border: Border.all(color: const Color(0xFFF3DFB3))),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(
                free ? 'AI pictures are free right now.' : 'This picture costs ${merchRupees(_charge)} · Paid wallet money ${merchRupees(_info.balancePaise)}',
                style: t(15, w: FontWeight.w800),
              ),
              if (_info.testCreditPaise > 0) Text('Free credit can’t pay for AI pictures.', style: t(14, color: C.muted, w: FontWeight.w700)),
              if (short > 0)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Row(children: [
                    Expanded(child: Text('You need ${merchRupees(short)} more', style: t(15, color: C.ruby))),
                    const SizedBox(width: 8),
                    DesiButton('Add money', icon: Icons.account_balance_wallet_rounded, kind: DesiButtonKind.gold, onTap: _working ? null : () => unawaited(_addMoney())),
                  ]),
                ),
            ]),
          ),
          if (showButton) ...[
            const SizedBox(height: 10),
            DesiButton(
              _baseArtId != null ? 'Change picture · ${merchRupees(_charge)}' : (free ? 'Create picture' : 'Create picture · ${merchRupees(_charge)}'),
              icon: Icons.auto_awesome_rounded,
              kind: DesiButtonKind.rani,
              expand: true,
              onTap: _canGenerate ? () => unawaited(_generate()) : null,
            ),
          ],
        ]),
      ),
    );
  }
}
