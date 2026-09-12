// [APP-ONLY-TX-APP-2] ONE reusable chat surface — list + composer + paperclip
// attach — shared by the waiting-room screen (inline) and the in-call chat
// sheet/panel (commercial_consult_screens.dart). Both wrap the SAME live
// `CommercialWaitingRoomChannel` the waiting room opened and keeps open for
// the whole session (including while the call screen is pushed on top of
// it) — this file never opens a second socket, it only fans the one
// channel's events out to whichever surface is on screen via
// [SessionChatController], a `ChangeNotifier` neither widget below owns the
// disposal of unless it created the controller itself (the waiting-room
// screen does; the in-call chat button just borrows it).
import 'dart:async';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/commercial_waiting_room_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';

class SessionChatLine {
  final String from, text;
  final int at;
  final bool mine;
  final ChatAttachment? attachment;
  const SessionChatLine({required this.from, required this.text, required this.at, required this.mine, this.attachment});
}

/// Wraps the ONE live [CommercialWaitingRoomChannel] and republishes its
/// `chat` events as a message list + unread counter both chat surfaces read.
/// Cancels only its OWN subscription on [dispose] — it never closes the
/// channel, which the waiting-room screen owns for the life of the session.
class SessionChatController extends ChangeNotifier {
  SessionChatController({
    required CommercialWaitingRoomChannel channel,
    required this.selfUid,
    required this.kind,
    required this.sessionId,
    required this.isCreator,
  }) : _channel = channel {
    _sub = _channel.events.listen(_onEvent);
  }

  final CommercialWaitingRoomChannel _channel;
  final String selfUid;
  /// 'consult' | 'live' — the `:kind` segment of the shared attachment route.
  final String kind;
  /// The booking/session id — the `:id` segment of the shared attachment route.
  final String sessionId;
  final bool isCreator;
  late final StreamSubscription<CommercialWaitingRoomEvent> _sub;

  final List<SessionChatLine> messages = [];
  int unread = 0;
  bool uploading = false;

  void _onEvent(CommercialWaitingRoomEvent e) {
    if (e is! CommercialWaitingRoomChat) return;
    final mine = e.uid != null ? e.uid == selfUid : e.from == selfUid;
    messages.add(SessionChatLine(from: e.from, text: e.text, at: e.at, mine: mine, attachment: e.attachment));
    if (!mine) unread++;
    notifyListeners();
  }

  /// Call when a chat surface showing these messages becomes visible (the
  /// waiting room's inline panel is always visible; the in-call sheet calls
  /// this the moment it opens) so the unread badge clears.
  void markRead() {
    if (unread == 0) return;
    unread = 0;
    notifyListeners();
  }

  void sendText(String text) {
    final t = text.trim();
    if (t.isEmpty) return;
    _channel.sendChat(t);
    Analytics.capture('waitroom_chat_sent', {
      'booking_id': sessionId,
      'role': isCreator ? 'creator' : 'buyer',
    });
  }

  // Extension-based best-effort MIME guess for a picked file — no `mime`
  // package dependency; the worker's own sniffing/validation still governs
  // acceptance.
  static const Map<String, String> _extMime = {
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
    'gif': 'image/gif', 'webp': 'image/webp', 'heic': 'image/heic',
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'txt': 'text/plain', 'csv': 'text/csv',
  };

  static String mimeFromName(String name) {
    final dot = name.lastIndexOf('.');
    if (dot < 0 || dot == name.length - 1) return 'application/octet-stream';
    return _extMime[name.substring(dot + 1).toLowerCase()] ?? 'application/octet-stream';
  }

  static String humanSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    const units = ['KB', 'MB', 'GB'];
    double v = bytes / 1024;
    var i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return '${v.toStringAsFixed(v < 10 ? 1 : 0)} ${units[i]}';
  }

  /// Picks + uploads a file and sends it as a chat message (empty text).
  /// Returns null on success or a user cancel; returns a user-facing error
  /// string on any failure (including the worker route not being deployed
  /// yet, e.g. a 404) — callers show it in a SnackBar, never a crash.
  Future<String?> attachFile() async {
    if (uploading) return null;
    FilePickerResult? res;
    try {
      res = await FilePicker.platform.pickFiles(withData: true);
    } catch (_) {
      return null;
    }
    final f = res?.files.single;
    if (f == null || f.bytes == null) return null;
    final Uint8List bytes = f.bytes!;
    if (bytes.length > CommercialWaitingRoomApi.maxAttachmentBytes) {
      return 'File is too large (25 MB max).';
    }
    final mime = mimeFromName(f.name);
    uploading = true;
    notifyListeners();
    try {
      final attachment = await CommercialWaitingRoomApi.uploadAttachment(
        kind: kind, id: sessionId, bytes: bytes, filename: f.name, mime: mime);
      _channel.sendChat('', attachment: attachment);
      Analytics.capture('session_chat_attachment_sent', {
        'booking_id': sessionId,
        'role': isCreator ? 'creator' : 'buyer',
        'mime': mime,
        'bytes': bytes.length,
      });
      return null;
    } catch (_) {
      // Covers a 404 (worker route not deployed yet) and any other upload
      // failure alike — the guard the shared contract requires.
      return 'Attachments not available yet';
    } finally {
      uploading = false;
      notifyListeners();
    }
  }

  @override
  void dispose() {
    unawaited(_sub.cancel());
    super.dispose();
  }
}

/// List + composer + attach button for a [SessionChatController]. Embedded
/// inline by the waiting room, and inside a bottom sheet / side panel by the
/// in-call chat button — same widget, same behaviour, either place.
class SessionChatPanel extends StatefulWidget {
  const SessionChatPanel({super.key, required this.controller, this.listHeight = 220});
  final SessionChatController controller;
  final double listHeight;

  @override
  State<SessionChatPanel> createState() => _SessionChatPanelState();
}

class _SessionChatPanelState extends State<SessionChatPanel> {
  final _textController = TextEditingController();
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onChange);
  }

  @override
  void didUpdateWidget(covariant SessionChatPanel old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller.removeListener(_onChange);
      widget.controller.addListener(_onChange);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChange);
    _textController.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _onChange() {
    if (!mounted) return;
    setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  void _send() {
    widget.controller.sendText(_textController.text);
    _textController.clear();
  }

  Future<void> _attach() async {
    final err = await widget.controller.attachFile();
    if (err != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    }
  }

  void _openImageFull(String url) {
    showDialog<void>(
      context: context,
      builder: (dctx) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: const EdgeInsets.all(12),
        child: Stack(children: [
          InteractiveViewer(
            minScale: 0.8,
            maxScale: 4,
            child: Center(
              child: Image.network(url,
                  errorBuilder: (_, __, ___) => const Padding(
                      padding: EdgeInsets.all(24),
                      child: Text('Image unavailable', style: TextStyle(color: Colors.white)))),
            ),
          ),
          Positioned(
            top: 8, right: 8,
            child: IconButton(
              icon: Icon(PhosphorIcons.x(PhosphorIconsStyle.bold), color: Colors.white),
              onPressed: () => Navigator.of(dctx).maybePop(),
            ),
          ),
        ]),
      ),
    );
  }

  Future<void> _openAttachmentFile(String url) async {
    try {
      final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
      if (!ok && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not open file')));
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not open file')));
      }
    }
  }

  /// One chat bubble's body: text (if any) plus, when present, the
  /// attachment — an image thumbnail that opens full-screen, or a file chip
  /// (name + human size) that opens externally via `url_launcher`.
  Widget _bubbleContent(SessionChatLine line) {
    final textColor = line.mine ? AD.onBand(AD.headerFooter) : AD.textPrimary;
    final attachment = line.attachment;
    final children = <Widget>[
      if (line.text.isNotEmpty) Text(line.text, style: ADText.bubbleBody(c: textColor)),
    ];
    if (attachment != null) {
      if (line.text.isNotEmpty) children.add(const SizedBox(height: Msg.s1));
      children.add(attachment.isImage
          ? GestureDetector(
              onTap: () => _openImageFull(attachment.url),
              child: ClipRRect(
                borderRadius: Msg.brSm,
                child: SizedBox(
                  height: 140,
                  width: 180,
                  child: Image.network(attachment.url, fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => ColoredBox(
                            color: AD.cardHover,
                            child: Icon(PhosphorIcons.imageBroken(PhosphorIconsStyle.regular), color: AD.textTertiary),
                          )),
                ),
              ),
            )
          : InkWell(
              onTap: () => _openAttachmentFile(attachment.url),
              borderRadius: Msg.brSm,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: Msg.s1),
                decoration: BoxDecoration(
                  color: AD.card,
                  borderRadius: Msg.brSm,
                  border: Border.all(color: AD.borderControl, width: 1),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  PhosphorIcon(PhosphorIcons.fileText(PhosphorIconsStyle.regular), size: 18, color: AD.textSecondary),
                  const SizedBox(width: Msg.s1),
                  Flexible(
                    child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(attachment.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ADText.preview(c: AD.textPrimary)),
                      Text(SessionChatController.humanSize(attachment.size), style: ADText.timestamp(c: AD.textTertiary)),
                    ]),
                  ),
                ]),
              ),
            ));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: children);
  }

  @override
  Widget build(BuildContext context) {
    final messages = widget.controller.messages;
    final uploading = widget.controller.uploading;
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Container(
        height: widget.listHeight,
        padding: const EdgeInsets.all(Msg.s3),
        decoration: BoxDecoration(color: AD.card, borderRadius: Msg.brMd, border: Border.all(color: AD.borderControl, width: 1)),
        child: messages.isEmpty
            ? Center(child: Text('No messages yet', style: ADText.preview(c: AD.textTertiary)))
            : ListView.builder(
                controller: _scroll,
                itemCount: messages.length,
                itemBuilder: (_, i) {
                  final line = messages[i];
                  return Align(
                    alignment: line.mine ? Alignment.centerRight : Alignment.centerLeft,
                    child: Container(
                      margin: const EdgeInsets.symmetric(vertical: Msg.s1),
                      padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
                      decoration: BoxDecoration(
                        color: line.mine ? AD.headerFooter : AD.cardHover,
                        borderRadius: Msg.brMd,
                      ),
                      child: _bubbleContent(line),
                    ),
                  );
                },
              ),
      ),
      const SizedBox(height: Msg.s2),
      Row(children: [
        IconButton(
          onPressed: uploading ? null : _attach,
          icon: uploading
              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
              : Icon(PhosphorIcons.paperclip(PhosphorIconsStyle.bold)),
        ),
        Expanded(
          child: TextField(
            controller: _textController,
            maxLength: 500,
            decoration: const InputDecoration(hintText: 'Message…', counterText: '', filled: true),
            onSubmitted: (_) => _send(),
          ),
        ),
        const SizedBox(width: Msg.s2),
        IconButton(onPressed: _send, icon: Icon(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.bold))),
      ]),
    ]);
  }
}
