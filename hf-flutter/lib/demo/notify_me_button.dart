import 'package:flutter/material.dart';

import '../data/api_exception.dart';
import '../data/repos/presence_repo.dart';
import '../data/services.dart';
import 'presence_bridge.dart';
import 'space_kit.dart'; // [HF-CREATOR-SPACES-1]
import 'theme.dart';
import 'widgets.dart';

/// "Notify me" on an offline influencer's profile (HF-REEL-15): needs an account, then one WhatsApp
/// when she goes online. [slug] is the public profile slug; [firstName] is for the toast.
class NotifyMeButton extends StatefulWidget {
  const NotifyMeButton({super.key, required this.slug, required this.firstName, this.repo, this.big = false});

  /// [HF-APP-DESI-4] Profile style: 58 dp plum pill with a bell.
  final bool big;

  final String slug;
  final String firstName;

  /// Tests inject a repo; the app builds one from [Services].
  final PresenceRepo? repo;

  @override
  State<NotifyMeButton> createState() => _NotifyMeButtonState();
}

class _NotifyMeButtonState extends State<NotifyMeButton> {
  bool _busy = false;
  bool _done = false;

  Future<void> _subscribe() async {
    final msg = 'We will WhatsApp you when ${widget.firstName} is online.';
    if (!PresenceBridge.real && widget.repo == null) {
      setState(() => _done = true);
      toast(context, msg);
      return;
    }
    setState(() => _busy = true);
    try {
      await (widget.repo ?? PresenceRepo(Services.instance.api)).notifyMe(widget.slug);
      if (!mounted) return;
      setState(() => _done = true);
      toast(context, msg);
    } on ApiException catch (e) {
      if (mounted && await handleLaneRequired(context, e)) return; // [HF-CREATOR-SPACES-1]
      if (mounted) toast(context, e.userMessage);
    } catch (_) {
      if (mounted) toast(context, ApiException.genericText);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Notify me',
      child: GestureDetector(
        onTap: (_busy || _done) ? null : () => requireAccount(context, _subscribe, reason: 'to get a WhatsApp when ${widget.firstName} is online'),
        child: widget.big
            ? Container(
                height: 58,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: _done ? C.lav : C.maroon, borderRadius: BorderRadius.circular(999)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(_done ? Icons.check_rounded : Icons.notifications_active_rounded, color: C.lemon, size: 20),
                  const SizedBox(width: 8),
                  Flexible(child: Text(_done ? 'We will WhatsApp you' : 'Notify me', maxLines: 1, overflow: TextOverflow.ellipsis, style: t(17, color: C.white, w: FontWeight.w900))),
                ]),
              )
            : Container(
          height: 48,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: _done ? C.sand : C.paper,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: C.maroon, width: 2),
          ),
          child: Text(_done ? 'We will WhatsApp you' : 'Notify me', style: t(16, color: C.maroon)),
        ),
      ),
    );
  }
}
