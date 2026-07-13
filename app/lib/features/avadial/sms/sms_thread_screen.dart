import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../avadial_channel.dart';
import '../device_contacts.dart';

/// One SMS in a thread (LIVE from the OS provider — never persisted by AvaTOK).
class _SmsRow {
  final String body;
  final int date; // epoch ms
  final bool outgoing; // Telephony.Sms.TYPE == 2 (sent)
  const _SmsRow({required this.body, required this.date, required this.outgoing});
}

/// A single SMS conversation + composer (AVA-SMS). Messages are read LIVE from the
/// OS SMS provider via the native channel; the composer sends via [AvaDialChannel.smsSend]
/// and paints delivery-state chips from the sent/delivered events. DARK behind the
/// `avaSms` flag + ROLE_SMS (the caller only pushes this when both hold).
class SmsThreadScreen extends StatefulWidget {
  final String address;
  const SmsThreadScreen({super.key, required this.address});

  @override
  State<SmsThreadScreen> createState() => _SmsThreadScreenState();
}

class _SmsThreadScreenState extends State<SmsThreadScreen> {
  final _composer = TextEditingController();
  final _scroll = ScrollController();
  List<_SmsRow> _rows = const [];
  bool _loading = true;
  bool _sending = false;

  // ref → latest delivery phase ('sending'|'sent'|'delivered'|'failed'), for chips.
  final Map<String, String> _outStatus = {};
  StreamSubscription<AvaSmsMessage>? _inSub;
  StreamSubscription<AvaSmsSendStatus>? _statusSub;

  @override
  void initState() {
    super.initState();
    _load();
    _inSub = AvaDialChannel.I.smsIncoming.listen((m) {
      if (_sameAddress(m.address)) _load();
    });
    _statusSub = AvaDialChannel.I.smsSendStatus.listen((s) {
      if (!mounted) return;
      setState(() {
        _outStatus[s.ref] = s.ok ? s.phase : 'failed';
      });
    });
  }

  @override
  void dispose() {
    _inSub?.cancel();
    _statusSub?.cancel();
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  bool _sameAddress(String? a) =>
      a != null && DeviceContacts.normKey(a) == DeviceContacts.normKey(widget.address);

  Future<void> _load() async {
    final raw = await AvaDialChannel.I.smsQueryMessages(widget.address);
    final rows = <_SmsRow>[];
    for (final r in raw) {
      final body = (r['body'] as String?) ?? '';
      rows.add(_SmsRow(
        body: body,
        date: (r['date'] as num?)?.toInt() ?? 0,
        outgoing: ((r['type'] as num?)?.toInt() ?? 0) == 2,
      ));
    }
    if (!mounted) return;
    setState(() {
      _rows = rows;
      _loading = false;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToEnd());
  }

  void _jumpToEnd() {
    if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
  }

  Future<void> _send() async {
    final text = _composer.text.trim();
    if (text.isEmpty || _sending) return;
    final ref = DateTime.now().microsecondsSinceEpoch.toString();
    setState(() {
      _sending = true;
      _outStatus[ref] = 'sending';
    });
    final ok = await AvaDialChannel.I.smsSend(widget.address, text, ref: ref);
    Analytics.capture('avadial_sms_sent', {'number_hash': AvaDialChannel.hashE164(widget.address), 'ok': ok});
    _composer.clear();
    if (!mounted) return;
    setState(() {
      _sending = false;
      if (!ok) _outStatus[ref] = 'failed';
    });
    // The provider mirror lands async; reload shortly to pick up the sent row.
    Future<void>.delayed(const Duration(milliseconds: 400), () {
      if (mounted) _load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final name = DeviceContacts.I.lookup(widget.address)?.name;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        foregroundColor: AD.textPrimary,
        leading: AdBackButton(),
        shape: const Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(name ?? widget.address, style: ZineText.appbar(color: AD.textPrimary)),
          if (name != null) Text(widget.address, style: ZineText.sub(size: 12, color: AD.textSecondary)),
        ]),
      ),
      body: SafeArea(
        child: Column(children: [
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator(color: AD.textPrimary))
                : _rows.isEmpty
                    ? const Center(
                        child: Text('No messages yet', style: TextStyle(color: AD.textSecondary)))
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                        itemCount: _rows.length,
                        itemBuilder: (context, i) => _bubble(_rows[i]),
                      ),
          ),
          _pendingChips(),
          _composerBar(),
        ]),
      ),
    );
  }

  Widget _bubble(_SmsRow r) {
    final mine = r.outgoing;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.76),
        decoration: BoxDecoration(
          color: mine ? AD.bubbleOutBg : AD.card,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AD.borderControl, width: 1),
          boxShadow: const [],
        ),
        child: Text(r.body,
            style: ZineText.value(size: 15, color: mine ? AD.bubbleOutInk : AD.textPrimary)),
      ),
    );
  }

  /// Delivery-state chips for messages sent this session (before the reload).
  Widget _pendingChips() {
    final active = _outStatus.entries.where((e) => e.value != 'delivered').toList();
    if (active.isEmpty) return const SizedBox.shrink();
    final latest = active.last.value;
    final label = switch (latest) {
      'sending' => 'Sending…',
      'sent' => 'Sent',
      'failed' => 'Failed to send',
      _ => latest,
    };
    final color = latest == 'failed' ? AD.danger : AD.textSecondary;
    return Padding(
      padding: const EdgeInsets.only(right: 18, bottom: 2),
      child: Align(
        alignment: Alignment.centerRight,
        child: Text(label, style: ZineText.tag(size: 11, color: color)),
      ),
    );
  }

  Widget _composerBar() {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      decoration: const BoxDecoration(
        color: AD.headerFooter,
        border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Expanded(
          child: AdField(
            controller: _composer,
            hint: 'Text message',
            keyboardType: TextInputType.text,
            textCapitalization: TextCapitalization.sentences,
            autocorrect: true,
            minLines: 1,
            maxLines: 5,
            onSubmitted: (_) => _send(),
          ),
        ),
        const SizedBox(width: 10),
        _SendButton(loading: _sending, onTap: _send),
      ]),
    );
  }
}

class _SendButton extends StatelessWidget {
  final bool loading;
  final VoidCallback onTap;
  const _SendButton({required this.loading, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return ZinePressable(
      onTap: loading ? null : onTap,
      color: AD.primaryBadge,
      radius: BorderRadius.circular(100),
      borderColor: AD.borderControl,
      borderWidth: 1,
      boxShadow: const [],
      padding: const EdgeInsets.all(14),
      child: loading
          ? const SizedBox(
              width: 20, height: 20,
              child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white))
          : Icon(PhosphorIcons.paperPlaneTilt(PhosphorIconsStyle.fill), size: 22, color: Colors.white),
    );
  }
}
