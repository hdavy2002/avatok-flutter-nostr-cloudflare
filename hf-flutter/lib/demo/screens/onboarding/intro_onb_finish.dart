import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../data/models/intro_onboarding.dart';
import '../../theme.dart';
import 'intro_onb_kit.dart';

// ------------------------------------------------------------------------------------------------------------------ 5 Profile

/// The profile step: name, one-line description, photo and rate per minute. The values are saved with `PUT /api/hosts/me` by the flow
/// when she presses Next. A live influencer (re-onboarding) can only change the rate: the server locks the other fields then.
class OnbProfileStep extends StatefulWidget {
  const OnbProfileStep({
    super.key,
    required this.name,
    required this.about,
    required this.rate,
    required this.photoUrl,
    required this.locked,
    required this.busy,
    required this.error,
    required this.onPhoto,
    required this.onChanged,
    required this.onNext,
    required this.onBack,
  });

  final String name;
  final String about;
  final int? rate;
  final String? photoUrl;

  /// A live influencer: name and description cannot be changed here.
  final bool locked;
  final bool busy;
  final String? error;
  final VoidCallback onPhoto;

  /// Called on every edit so the flow can keep the draft.
  final void Function(String name, String about, int? rate) onChanged;
  final void Function(String name, String about, int rate) onNext;
  final VoidCallback onBack;

  @override
  State<OnbProfileStep> createState() => _OnbProfileStepState();
}

class _OnbProfileStepState extends State<OnbProfileStep> {
  static const int _nameMax = 40;
  static const int _aboutMax = 120;

  late final TextEditingController _name = TextEditingController(text: widget.name);
  late final TextEditingController _about = TextEditingController(text: widget.about);
  late final TextEditingController _rate = TextEditingController(text: widget.rate == null ? '' : '${widget.rate}');
  String? _localError;

  @override
  void dispose() {
    _name.dispose();
    _about.dispose();
    _rate.dispose();
    super.dispose();
  }

  int? get _rateValue => int.tryParse(_rate.text.trim());

  void _changed() {
    widget.onChanged(_name.text.trim(), _about.text.trim(), _rateValue);
    if (_localError != null) setState(() => _localError = null);
  }

  void _next() {
    final name = _name.text.trim();
    final about = _about.text.trim();
    final rate = _rateValue;
    String? problem;
    if (!widget.locked && name.length < 2) {
      problem = 'Type your name (at least 2 letters).';
    } else if (!widget.locked && about.isEmpty) {
      problem = 'Write one line about what you talk about.';
    } else if (widget.photoUrl == null || widget.photoUrl!.isEmpty) {
      problem = 'Add a clear photo of your face.';
    } else if (rate == null || rate < 1) {
      problem = 'Type your rate per minute, in rupees.';
    }
    if (problem != null) {
      setState(() => _localError = problem);
      return;
    }
    widget.onNext(name, about, rate!);
  }

  Widget _label(String text) => Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(text, style: t(15, color: IO.ink, w: FontWeight.w800)));

  @override
  Widget build(BuildContext context) {
    final photo = widget.photoUrl;
    final hasPhoto = photo != null && photo.isNotEmpty;
    return OnbScaffold(
      step: OnbStep.profile,
      eyebrow: 'Your profile',
      title: 'How fans will see you',
      subtitle: widget.locked ? 'You are live, so only your rate can change here.' : 'Fans see this next to your video.',
      titleSize: 27,
      onBack: widget.busy ? null : widget.onBack,
      primaryLabel: 'Next',
      primaryBusy: widget.busy,
      onPrimary: _next,
      error: _localError ?? widget.error,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        OnbCard(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              Semantics(
                button: true,
                label: hasPhoto ? 'Change your photo' : 'Add your photo',
                excludeSemantics: true,
                onTap: widget.onPhoto,
                child: InkWell(
                  customBorder: const CircleBorder(),
                  onTap: widget.onPhoto,
                  child: SizedBox(
                    width: 88,
                    height: 88,
                    child: ClipOval(
                      child: DecoratedBox(
                        decoration: BoxDecoration(color: IO.tagBg, border: Border.all(color: IO.ink, width: 2.5), shape: BoxShape.circle),
                        child: hasPhoto
                            ? Image.network(photo, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const Icon(Icons.person_rounded, size: 44, color: IO.ink))
                            : const Icon(Icons.add_a_photo_rounded, size: 34, color: IO.ink),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(hasPhoto ? 'Your photo' : 'Add your photo', style: t(16, color: IO.ink, w: FontWeight.w900)),
                  const SizedBox(height: 2),
                  Text('A clear photo of your face. No sunglasses.', style: t(14, color: IO.muted, w: FontWeight.w600, h: 1.4)),
                  OnbLinkButton(label: hasPhoto ? 'Change photo' : 'Choose photo', onTap: widget.onPhoto),
                ]),
              ),
            ]),
          ]),
        ),
        const SizedBox(height: 14),
        OnbCard(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            _label('Your name'),
            TextField(
              controller: _name,
              enabled: !widget.locked && !widget.busy,
              textCapitalization: TextCapitalization.words,
              textInputAction: TextInputAction.next,
              maxLength: _nameMax,
              style: t(18, color: IO.ink, w: FontWeight.w800),
              decoration: onbInputDecoration('Name fans will see', enabled: !widget.locked),
              onChanged: (_) => _changed(),
            ),
            const SizedBox(height: 14),
            _label('One line about you'),
            TextField(
              controller: _about,
              enabled: !widget.locked && !widget.busy,
              textCapitalization: TextCapitalization.sentences,
              maxLength: _aboutMax,
              maxLines: 3,
              minLines: 2,
              style: t(16, color: IO.ink, w: FontWeight.w700),
              decoration: onbInputDecoration('For example: Gentle chats about life, in Hindi', enabled: !widget.locked),
              onChanged: (_) => _changed(),
            ),
            const SizedBox(height: 14),
            _label('Your rate per minute (₹)'),
            TextField(
              controller: _rate,
              enabled: !widget.busy,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
              style: t(20, color: IO.ink, w: FontWeight.w800),
              decoration: onbInputDecoration('For example 20'),
              onChanged: (_) => _changed(),
            ),
            const SizedBox(height: 8),
            Text('You can change your rate any time later.', style: t(14, color: IO.muted, w: FontWeight.w600, h: 1.4)),
          ]),
        ),
      ]),
    );
  }
}

// ------------------------------------------------------------------------------------------------------- 6 How do you take calls

/// Step 6 (design "How do you want to take calls?"): `'A'` Bookings only, `'B'` Bookings + live calls.
class OnbOptionStep extends StatelessWidget {
  const OnbOptionStep({
    super.key,
    required this.selected,
    required this.busy,
    required this.error,
    required this.onPick,
    required this.onSlots,
    required this.onSubmit,
    required this.onBack,
    this.primaryLabel = 'Send for approval',
  });

  /// [HF-CALL-SAFETY-APP] "Next" while the call rules step follows (hfCallRecordingEnabled), else "Send for approval".
  final String primaryLabel;

  final String selected;
  final bool busy;
  final String? error;
  final ValueChanged<String> onPick;

  /// Opens the existing availability screen.
  final VoidCallback onSlots;
  final VoidCallback onSubmit;
  final VoidCallback onBack;

  Widget _tag(String text) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(color: IO.tagBg, borderRadius: BorderRadius.circular(999)),
        child: Text(text, style: t(14, color: IO.ink, w: FontWeight.w700)),
      );

  Widget _card({
    required String id,
    required IconData icon,
    required Color tile,
    required String title,
    required String body,
    required List<String> tags,
  }) {
    final on = selected == id;
    return Semantics(
      button: true,
      selected: on,
      label: title,
      excludeSemantics: true,
      onTap: () => onPick(id),
      child: InkWell(
        borderRadius: BorderRadius.circular(22),
        onTap: busy ? null : () => onPick(id),
        child: OnbCard(
          border: on ? IO.pink : IO.ink,
          shadow: on ? IO.pink : null,
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(color: tile, borderRadius: BorderRadius.circular(14)),
                alignment: Alignment.center,
                child: Icon(icon, size: 26, color: IO.ink),
              ),
              const SizedBox(width: 12),
              Expanded(child: Text(title, style: t(20, color: IO.ink, w: FontWeight.w900, h: 1.15))),
              if (on)
                Container(
                  width: 30,
                  height: 30,
                  decoration: const BoxDecoration(color: IO.pink, shape: BoxShape.circle),
                  alignment: Alignment.center,
                  child: const Icon(Icons.check_rounded, size: 20, color: IO.white),
                ),
            ]),
            const SizedBox(height: 10),
            Text(body, style: t(15, color: IO.ink, w: FontWeight.w600, h: 1.5)),
            const SizedBox(height: 10),
            Wrap(spacing: 8, runSpacing: 8, children: [for (final x in tags) _tag(x)]),
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return OnbScaffold(
      step: OnbStep.option,
      title: 'How do you want to take calls?',
      titleSize: 27,
      subtitle: 'You can change this any time from your Home screen.',
      onBack: busy ? null : onBack,
      primaryLabel: primaryLabel,
      primaryBusy: busy,
      onPrimary: onSubmit,
      error: error,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _card(
          id: 'A',
          icon: Icons.calendar_month_rounded,
          tile: IO.bookingsIcon,
          title: 'Bookings only',
          body: 'Fans pick a time from your calendar. Nobody can call you without a booking.',
          tags: const ['Your reel always shows', '“Book a time”'],
        ),
        const SizedBox(height: 16),
        _card(
          id: 'B',
          icon: Icons.call_rounded,
          tile: IO.yellow,
          title: 'Bookings + live calls',
          body: 'When you switch Online, fans can call you right away. On a call? They join a queue or book a time. Offline? They can still book.',
          tags: const ['“Call now” when online', 'Queue when busy', 'Hidden from Reels when offline'],
        ),
        const SizedBox(height: 16),
        Semantics(
          button: true,
          label: 'Set your free time slots',
          excludeSemantics: true,
          onTap: onSlots,
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: busy ? null : onSlots,
            child: OnbDashed(
              radius: 14,
              width: 2.5,
              child: Container(
                constraints: const BoxConstraints(minHeight: 52),
                alignment: Alignment.center,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Text('Set your free time slots →', style: t(16, color: IO.ink, w: FontWeight.w900)),
              ),
            ),
          ),
        ),
      ]),
    );
  }
}

// ------------------------------------------------------------------------------------------------------------ 7 Sent / result

class _StatusRow extends StatelessWidget {
  const _StatusRow({required this.mark, required this.text, this.done = false, this.current = false});

  final String mark;
  final String text;
  final bool done;
  final bool current;

  @override
  Widget build(BuildContext context) {
    return Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
      Container(
        width: 30,
        height: 30,
        decoration: BoxDecoration(
          color: done ? IO.ink : (current ? IO.yellow : IO.white),
          shape: BoxShape.circle,
          border: Border.all(color: IO.ink, width: 2),
        ),
        alignment: Alignment.center,
        child: done ? const Icon(Icons.check_rounded, size: 18, color: IO.white) : Text(mark, style: t(14, color: IO.ink, w: FontWeight.w900)),
      ),
      const SizedBox(width: 12),
      Expanded(child: Text(text, style: t(15, color: IO.ink, w: FontWeight.w700, h: 1.35))),
    ]);
  }
}

/// A big round badge with an icon, used by the sent / rejected / approved screens.
class _Badge extends StatelessWidget {
  const _Badge({required this.icon, required this.fill, required this.shadow});

  final IconData icon;
  final Color fill;
  final Color shadow;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: Container(
          width: 150,
          height: 150,
          decoration: BoxDecoration(
            color: fill,
            shape: BoxShape.circle,
            border: Border.all(color: IO.ink, width: 4),
            boxShadow: [BoxShadow(color: shadow, offset: const Offset(8, 8))],
          ),
          alignment: Alignment.center,
          child: Icon(icon, size: 64, color: IO.ink),
        ),
      );
}

class _ResultPage extends StatelessWidget {
  const _ResultPage({
    required this.badge,
    required this.eyebrow,
    required this.title,
    required this.body,
    required this.primaryLabel,
    required this.onPrimary,
    this.extra,
    this.secondaryLabel,
    this.onSecondary,
  });

  final Widget badge;
  final String eyebrow;
  final String title;
  final String body;
  final Widget? extra;
  final String primaryLabel;
  final VoidCallback onPrimary;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(children: [
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 40, 20, 12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.center, children: [
                badge,
                const SizedBox(height: 18),
                Text(eyebrow.toUpperCase(), style: t(14, color: IO.pink, w: FontWeight.w900, ls: 0.18)),
                const SizedBox(height: 6),
                Semantics(header: true, child: Text(title, textAlign: TextAlign.center, style: t(32, color: IO.ink, w: FontWeight.w900, h: 1.08))),
                const SizedBox(height: 12),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 340),
                  child: Text(body, textAlign: TextAlign.center, style: t(16, color: IO.ink, w: FontWeight.w600, h: 1.55)),
                ),
                if (extra != null) ...[const SizedBox(height: 18), extra!],
              ]),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 14),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              OnbPrimaryButton(label: primaryLabel, onTap: onPrimary),
              if (secondaryLabel != null) OnbLinkButton(label: secondaryLabel!, onTap: onSecondary),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// Step 7 (design "Sent for approval").
class OnbSentScreen extends StatelessWidget {
  const OnbSentScreen({super.key, required this.onHome});

  final VoidCallback onHome;

  @override
  Widget build(BuildContext context) {
    return _ResultPage(
      badge: const _Badge(icon: Icons.mark_email_read_rounded, fill: IO.yellow, shadow: IO.pink),
      eyebrow: 'All done',
      title: 'Sent for approval',
      body: 'A person from our team will watch your video and check your profile. Once approved, you can receive calls. We’ll tell you on WhatsApp.',
      extra: const OnbCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _StatusRow(mark: '1', text: 'Video and profile sent', done: true),
          SizedBox(height: 14),
          _StatusRow(mark: '2', text: 'Our team checks it (usually within a day)', current: true),
          SizedBox(height: 14),
          _StatusRow(mark: '3', text: 'You’re live — your reel appears for fans'),
        ]),
      ),
      primaryLabel: 'Go to Home',
      onPrimary: onHome,
    );
  }
}

/// The team said no: the reasons, and a way back into the flow.
class OnbRejectedScreen extends StatelessWidget {
  const OnbRejectedScreen({super.key, required this.reasons, required this.note, required this.onFix, required this.onHome});

  final List<OnbReason> reasons;
  final String? note;
  final VoidCallback onFix;
  final VoidCallback onHome;

  @override
  Widget build(BuildContext context) {
    return _ResultPage(
      badge: const _Badge(icon: Icons.edit_note_rounded, fill: IO.cream, shadow: IO.orange),
      eyebrow: 'Almost there',
      title: 'Please fix a few things',
      body: 'Our team looked at your application and needs a change before you can go live.',
      extra: OnbCard(
        color: IO.cream,
        border: IO.orange,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          for (var i = 0; i < reasons.length; i++)
            Padding(
              padding: EdgeInsets.only(bottom: i == reasons.length - 1 && (note == null) ? 0 : 10),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('•  ', style: t(15, color: IO.orangeInk, w: FontWeight.w900)),
                Expanded(child: Text(reasons[i].text, style: t(15, color: IO.ink, w: FontWeight.w700, h: 1.45))),
              ]),
            ),
          if (reasons.isEmpty && (note == null || note!.isEmpty))
            Text('Please check your video and profile, then send it again.', style: t(15, color: IO.ink, w: FontWeight.w700, h: 1.45)),
          if (note != null && note!.isNotEmpty) Text('Note from our team: $note', style: t(15, color: IO.ink, w: FontWeight.w700, h: 1.45)),
        ]),
      ),
      primaryLabel: 'Fix and send again',
      onPrimary: onFix,
      secondaryLabel: 'Go to Home',
      onSecondary: onHome,
    );
  }
}

/// Approved: she is live now.
class OnbApprovedScreen extends StatelessWidget {
  const OnbApprovedScreen({super.key, required this.onDashboard});

  final VoidCallback onDashboard;

  @override
  Widget build(BuildContext context) {
    return _ResultPage(
      badge: const _Badge(icon: Icons.celebration_rounded, fill: IO.yellow, shadow: IO.pink),
      eyebrow: 'You’re in',
      title: 'You’re approved',
      body: 'Your reel is on its way to fans. Open your dashboard to switch Online and see your bookings.',
      primaryLabel: 'Open my dashboard',
      onPrimary: onDashboard,
    );
  }
}
