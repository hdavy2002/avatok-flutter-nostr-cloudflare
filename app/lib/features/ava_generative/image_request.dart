/// Ava image-generation request affordance (Phase 9 — Generative).
///
/// A small composer/sheet — "Ava, make a logo about…" — that kicks off an async
/// in-thread image generation for a given conversation. Tapping "Generate" POSTs
/// to `/api/ava/image`; gating is SERVER-side via the Phase-1 subscription
/// allowance (Free 3/day, Plus 30, Pro 100, Max unlimited). When the daily grant
/// is spent the worker returns a blocked response with an upgrade message, which
/// this sheet surfaces inline — no client-side wallet check.
///
/// The sheet itself shows almost nothing after kickoff: the worker immediately
/// posts the "Ava is generating an image…" chip into the conversation and the
/// finished image drops in as an `ava` message — both rendered by the frozen
/// chat pipeline. So we just confirm "on its way" and close.
///
/// Open it from a chat's Ava menu / a "+" attachment action:
///   ImageRequestSheet.show(context, convKey: state._convKey, chatLabel: name);
library;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'image_tool.dart';

class ImageRequestSheet extends StatefulWidget {
  /// Client-local conversation key ('1:<peerUid>' | 'g:<gid>') the image lands in.
  final String convKey;

  /// Friendly chat label for the header.
  final String? chatLabel;

  /// Optional existing image to EDIT ("make it blue") instead of generating fresh.
  final String? editMediaRef;

  const ImageRequestSheet({
    super.key,
    required this.convKey,
    this.chatLabel,
    this.editMediaRef,
  });

  static Future<void> show(
    BuildContext context, {
    required String convKey,
    String? chatLabel,
    String? editMediaRef,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (_) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: ImageRequestSheet(
            convKey: convKey, chatLabel: chatLabel, editMediaRef: editMediaRef),
      ),
    );
  }

  @override
  State<ImageRequestSheet> createState() => _ImageRequestSheetState();
}

class _ImageRequestSheetState extends State<ImageRequestSheet> {
  final TextEditingController _ctrl = TextEditingController();
  bool _sending = false;
  String? _error;

  bool get _isEdit => widget.editMediaRef != null && widget.editMediaRef!.isNotEmpty;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _kickoff() async {
    final prompt = _ctrl.text.trim();
    if (prompt.isEmpty || _sending) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    final out = await requestAvaImage(
      convKey: widget.convKey,
      prompt: prompt,
      editMediaRef: widget.editMediaRef,
    );
    if (!mounted) return;
    final ok = out['ok'] == true || out['async'] == true;
    if (ok) {
      Navigator.of(context).maybePop();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_isEdit
            ? 'Ava is editing the image — it will appear in the chat.'
            : 'Ava is generating your image — it will appear in the chat.')),
      );
      return;
    }
    final blocked = out['blocked'] == true;
    setState(() {
      _sending = false;
      _error = blocked
          ? (out['message'] ?? "I can't create that image. Try a different idea.").toString()
          : 'Could not start generation. Please try again.';
    });
  }

  @override
  Widget build(BuildContext context) {
    final title = _isEdit ? 'Edit with Ava' : 'Make an image with Ava';
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              ZineIconBadge(
                  icon: PhosphorIcons.magicWand(PhosphorIconsStyle.fill),
                  color: Zine.lilac,
                  size: 38),
              const SizedBox(width: 12),
              Expanded(child: Text(title, style: ZineText.cardTitle(size: 18))),
            ]),
            const SizedBox(height: 6),
            if (widget.chatLabel != null)
              Text('Posts into ${widget.chatLabel}', style: ZineText.sub(size: 12.5)),
            const SizedBox(height: 14),
            Container(
              decoration: BoxDecoration(
                color: Zine.card,
                borderRadius: BorderRadius.circular(16),
                border: Zine.border,
              ),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
              child: TextField(
                controller: _ctrl,
                autofocus: true,
                minLines: 2,
                maxLines: 5,
                maxLength: 2000,
                textInputAction: TextInputAction.newline,
                style: ZineText.input(size: 15),
                decoration: InputDecoration(
                  border: InputBorder.none,
                  counterText: '',
                  hintText: _isEdit
                      ? 'e.g. make it blue, add a sunset…'
                      : 'e.g. a minimalist logo for a coffee brand…',
                  hintStyle: ZineText.sub(size: 14.5),
                ),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: ZineText.sub(size: 13, color: Zine.coral)),
            ],
            const SizedBox(height: 16),
            // Gating is server-side (subscription allowance). Just kick off the
            // request; the worker allows it (within the daily grant) or returns an
            // upgrade message we surface via [_error].
            ZineButton(
              label: _sending
                  ? 'Starting…'
                  : (_isEdit ? 'Edit image' : 'Generate image'),
              variant: ZineButtonVariant.blue,
              fullWidth: true,
              fontSize: 16,
              loading: _sending,
              icon: PhosphorIcons.sparkle(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: _sending ? null : _kickoff,
            ),
            const SizedBox(height: 8),
            Text(
              'Your plan includes a set number of AI images per day (Free: 3). '
              'When you run out, Ava will let you know. The image arrives in the '
              'chat when it is ready — you can keep chatting.',
              style: ZineText.sub(size: 12),
            ),
          ],
        ),
      ),
    );
  }
}
