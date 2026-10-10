import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/format/money.dart';
import '../../../core/links.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/me_api.dart';
import '../data/me_telemetry.dart';

/// Copy of the delete-account screen, in simple English.
abstract final class DeleteCopy {
  static const String title = 'Delete my account';
  static const String deleteIntro = 'We found no money that needs to be settled. You can delete your account now.';
  static const String exitIntro = 'You have money in your account. We settle it first, then delete your account.';
  static const String whatHappens = 'What happens next';
  static const String waitTime = 'Your account goes into a 30-day waiting time. You can change your mind in that time.';
  static const String dataDeleted = "After 30 days your data is deleted, as India's data protection law (DPDP) asks.";
  static const String testDropped = 'Test credits and test earnings have no cash value. They are removed.';
  static const String readMore = 'Read about data deletion';
  static const String ack = 'I understand and want to delete my account.';
  static const String deleteButton = 'Delete my account';
  static const String closeButton = 'Settle my money and delete my account';
  static const String forfeitNoBank = 'No bank account is verified, so we cannot pay your earnings.';
  static const String forfeitOther = 'Some of your money cannot be paid out.';
  static const String addBank = 'Add my bank account';
  static const String notEnabled = 'Closing your account this way is not open right now.';
  static const String settleFirst = 'You have money to settle first. Please check the details below.';

  static const String scheduledTitle = 'Your account is scheduled for deletion';
  static const String keepAccount = 'Keep my account';
  static const String signOut = 'Sign out';
  static const String keptSnack = 'Your account is safe. Nothing will be deleted.';

  static const String statusTitle = 'We are closing your account';
  static const String statusHold = 'Some of your earnings are still on hold. We pay them out as soon as the hold ends.';
  static const String statusPayouts = 'We are paying out your money. Your account is deleted once that is done.';
  static const String statusReady = 'Your money is settled. We are deleting your account now.';
  static const String cancelClosing = 'Cancel closing my account';
  static const String cancelledSnack = 'Closing was cancelled. Your account stays.';

  static String forfeitLabel(String amount) => 'I give up $amount.';

  static String payoutStatus(String status) {
    switch (status) {
      case 'requested':
        return 'Waiting for approval';
      case 'approved':
        return 'Approved, being paid';
      case 'paid':
        return 'Paid';
      case 'rejected':
        return 'Not paid';
      default:
        return status.isEmpty ? 'Waiting' : status;
    }
  }

  static String refundStatus(String status) {
    switch (status) {
      case 'requested':
        return 'Refund requested from Google Play';
      case 'processing':
        return 'Refund in progress';
      case 'refunded':
        return 'Refunded';
      case 'rejected':
        return 'Not refunded';
      case 'cancelled':
        return 'Cancelled';
      default:
        return status.isEmpty ? 'Waiting' : status;
    }
  }
}

const List<String> _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// `12 Nov 2026` from epoch milliseconds, in the phone's time zone.
String formatDay(int epochMs) {
  final d = DateTime.fromMillisecondsSinceEpoch(epochMs);
  return '${d.day} ${_months[d.month - 1]} ${d.year}';
}

/// `/me/delete` (needs sign-in). Built in HF-NATIVE-12 (spec 2.15).
///
/// The worker decides the path (`GET /api/hf/account/exit`):
///  - `delete`: nothing to settle. Confirm, then `POST /api/account/delete` starts the 30-day wait.
///    A `409 {deferred:true}` means money turned up: the screen switches to the settle path.
///  - `exit`: unused purchased tokens are refunded through Google Play, host earnings are paid out first,
///    then the account is deleted. `POST /api/hf/account/exit {forfeit}` with an Idempotency-Key starts it.
///    Refusals: `409 active_call` (finish the call), `forfeit_required {forfeitRupees}` (tick to give it up),
///    `bank_required`, `nothing_to_settle` (switches to the delete path).
/// An account already closing shows the status (money and deletion date) with a way to change its mind.
class DeleteAccountScreen extends ConsumerStatefulWidget {
  const DeleteAccountScreen({super.key});

  @override
  ConsumerState<DeleteAccountScreen> createState() => _DeleteAccountScreenState();
}

class _DeleteAccountScreenState extends ConsumerState<DeleteAccountScreen> {
  bool _ack = false;
  bool _forfeit = false;
  bool _busy = false;
  String? _error;

  /// Show the settle path even when the worker's last answer said delete (after a 409 deferred).
  bool _forceExit = false;

  /// A forfeit amount the worker asked for (`forfeit_required`), when the summary did not show one.
  num _forfeitFromError = 0;

  /// Set when `POST /api/account/delete` succeeded: the end of the 30-day wait.
  int? _scheduledAt;

  /// Kept while a closing attempt has no answer (offline), so the retry is a replay and never a second closure.
  String? _idempotencyKey;

  void _setError(String? message) {
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = message;
    });
  }

  Future<void> _refresh() async {
    ref.invalidate(exitStateProvider);
    unawaited(ref.read(sessionProvider.notifier).refreshMe());
  }

  // ---- steps ----------------------------------------------------------------------------------------

  Future<void> _delete() async {
    if (_busy) return;
    MeTelemetry.deleteStarted('delete');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final at = await ref.read(accountApiProvider).deleteAccount();
      MeTelemetry.deleteResult('delete', 'ok');
      if (!mounted) return;
      setState(() {
        _busy = false;
        _scheduledAt = at ?? DateTime.now().add(const Duration(days: 30)).millisecondsSinceEpoch;
      });
      await _refresh();
    } on ApiError catch (e) {
      if (isDeferred(e)) {
        // Money turned up since the screen loaded: switch to the settle path.
        MeTelemetry.deleteResult('delete', 'deferred', status: e.status);
        if (!mounted) return;
        setState(() {
          _busy = false;
          _forceExit = true;
          _ack = false;
          _error = DeleteCopy.settleFirst;
        });
        ref.invalidate(exitStateProvider);
        return;
      }
      MeTelemetry.deleteResult('delete', 'failed', reason: e.code, status: e.status);
      _setError(e.userMessage);
    }
  }

  Future<void> _settleAndClose(ExitState s) async {
    if (_busy) return;
    MeTelemetry.deleteStarted('exit');
    setState(() {
      _busy = true;
      _error = null;
    });
    _idempotencyKey ??= newIdempotencyKey(ref.read(sessionProvider).me?.uid);
    try {
      await ref.read(accountApiProvider).startExit(forfeit: _forfeit, idempotencyKey: _idempotencyKey!);
      MeTelemetry.deleteResult('exit', 'ok');
      _idempotencyKey = null;
      if (!mounted) return;
      setState(() {
        _busy = false;
        _ack = false;
      });
      await _refresh();
    } on ApiError catch (e) {
      // A refusal is final for this attempt; only "no answer" keeps the key so the retry is a replay.
      if (!e.isOffline) _idempotencyKey = null;
      MeTelemetry.deleteResult('exit', 'failed', reason: e.code, status: e.status);
      if (e.code == 'nothing_to_settle') {
        // Nothing left to pay: the plain delete path applies now.
        if (!mounted) return;
        setState(() {
          _busy = false;
          _forceExit = false;
          _error = e.userMessage;
        });
        ref.invalidate(exitStateProvider);
        return;
      }
      if (e.code == 'forfeit_required') {
        final v = e.extra['forfeitRupees'];
        if (!mounted) return;
        setState(() {
          _busy = false;
          _forfeitFromError = v is num ? v : s.forfeitRupees;
          _error = e.userMessage;
        });
        return;
      }
      _setError(e.userMessage);
    }
  }

  Future<void> _cancelClosing() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(accountApiProvider).cancelExit();
      if (!mounted) return;
      setState(() {
        _busy = false;
        _ack = false;
        _forceExit = false;
      });
      _snack(DeleteCopy.cancelledSnack);
      await _refresh();
    } on ApiError catch (e) {
      _setError(e.userMessage);
    }
  }

  Future<void> _keepAccount() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(accountApiProvider).cancelDeletion();
      if (!mounted) return;
      setState(() {
        _busy = false;
        _scheduledAt = null;
        _ack = false;
      });
      _snack(DeleteCopy.keptSnack);
      await _refresh();
    } on ApiError catch (e) {
      _setError(e.userMessage);
    }
  }

  Future<void> _signOut() async {
    GoRouter.of(context).go(Routes.home);
    await ref.read(sessionProvider.notifier).signOut();
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text, style: HfText.bodyText.copyWith(color: HfColors.cream))));
  }

  // ---- build ----------------------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(exitStateProvider);
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        leading: const HfBackButton(),
        title: const Text(DeleteCopy.title),
      ),
      body: SafeArea(
        child: AsyncValueView<ExitState>(
          value: state,
          loadingMessage: 'Checking your account…',
          onRetry: () => ref.invalidate(exitStateProvider),
          data: (s) => SingleChildScrollView(
            padding: const EdgeInsets.all(HfSpacing.page),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: _content(context, s),
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _content(BuildContext context, ExitState s) {
    final deletionAt = _scheduledAt ?? s.deletionAt;
    if (deletionAt != null) return _scheduledView(deletionAt);
    if (s.exitActive) return _statusView(s);
    if (s.mustSettle || _forceExit) return _settleView(s);
    return _deleteView();
  }

  Widget _errorBox() {
    final e = _error;
    if (e == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: HfSpacing.gap),
      child: HfCard(
        key: const ValueKey<String>('delete-error'),
        color: HfColors.blush,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.error_outline_rounded, color: HfColors.accent),
            const SizedBox(width: 12),
            Expanded(child: Text(e, style: HfText.bodyText)),
          ],
        ),
      ),
    );
  }

  Widget _bullet(IconData icon, String text, {Key? key}) {
    return Padding(
      key: key,
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 22, color: HfColors.orchid),
          const SizedBox(width: 12),
          Expanded(child: Text(text, style: HfText.bodyText)),
        ],
      ),
    );
  }

  Widget _ackBox({required Key key, required String label, required bool value, required ValueChanged<bool> onChanged}) {
    return InkWell(
      onTap: _busy ? null : () => onChanged(!value),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: HfSpacing.tap),
        child: Row(
          children: [
            Checkbox(key: key, value: value, onChanged: _busy ? null : (v) => onChanged(v ?? false)),
            Expanded(child: Text(label, style: HfText.bodyText)),
          ],
        ),
      ),
    );
  }

  Widget _readMore() => HfButton(
        key: const ValueKey<String>('delete-read-more'),
        label: DeleteCopy.readMore,
        kind: HfButtonKind.text,
        icon: Icons.open_in_new_rounded,
        onPressed: () => unawaited(LinkOpener.instance.site('/data-deletion')),
      );

  // ---- delete path ----------------------------------------------------------------------------------

  List<Widget> _deleteView() => [
        _errorBox(),
        const Text(DeleteCopy.deleteIntro, style: HfText.bodyText),
        const SizedBox(height: HfSpacing.gapLarge),
        HfCard(
          key: const ValueKey<String>('delete-path'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(DeleteCopy.whatHappens, style: HfText.subtitle),
              const SizedBox(height: 12),
              _bullet(Icons.hourglass_bottom_rounded, DeleteCopy.waitTime),
              _bullet(Icons.shield_outlined, DeleteCopy.dataDeleted),
              _bullet(Icons.toll_outlined, DeleteCopy.testDropped),
            ],
          ),
        ),
        _readMore(),
        const SizedBox(height: HfSpacing.gap),
        _ackBox(
          key: const ValueKey<String>('delete-ack'),
          label: DeleteCopy.ack,
          value: _ack,
          onChanged: (v) => setState(() => _ack = v),
        ),
        const SizedBox(height: HfSpacing.gap),
        HfButton(
          key: const ValueKey<String>('delete-confirm'),
          label: DeleteCopy.deleteButton,
          loading: _busy,
          onPressed: _ack ? () => unawaited(_delete()) : null,
        ),
      ];

  // ---- settle (exit) path ---------------------------------------------------------------------------

  List<Widget> _settleView(ExitState s) {
    final forfeit = s.forfeitRupees > 0 ? s.forfeitRupees : _forfeitFromError;
    final needsForfeit = forfeit > 0;
    final heldOn = s.heldReleaseAt;
    final canStart = _ack && (!needsForfeit || _forfeit);
    return [
      _errorBox(),
      const Text(DeleteCopy.exitIntro, style: HfText.bodyText),
      const SizedBox(height: HfSpacing.gapLarge),
      HfCard(
        key: const ValueKey<String>('exit-path'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Your money', style: HfText.subtitle),
            const SizedBox(height: 12),
            if (s.refundable > 0)
              _bullet(
                Icons.undo_rounded,
                'Your unused tokens, worth ${Money.rupees(s.refundable)}, are refunded through Google Play. We send the request to Google for you.',
                key: const ValueKey<String>('exit-refund'),
              ),
            if (s.withdrawable > 0 && s.bankOk)
              _bullet(
                Icons.account_balance_rounded,
                'Your earnings of ${Money.rupees(s.withdrawable)} are paid to your verified bank account first.',
                key: const ValueKey<String>('exit-payout'),
              ),
            if (s.held > 0)
              _bullet(
                Icons.schedule_rounded,
                heldOn != null
                    ? 'Earnings of ${Money.rupees(s.held)} are on hold until ${formatDay(heldOn)}. We pay them out then.'
                    : 'Earnings of ${Money.rupees(s.held)} are on hold. We pay them out when the hold ends.',
                key: const ValueKey<String>('exit-held'),
              ),
            if (s.manualRefund > 0)
              _bullet(
                Icons.support_agent_rounded,
                '${Money.rupees(s.manualRefund)} of unused top-up money is refunded by our team.',
                key: const ValueKey<String>('exit-manual'),
              ),
            if (s.testCredits > 0 || s.testEarnings > 0) _bullet(Icons.toll_outlined, DeleteCopy.testDropped),
            if (s.refundable <= 0 && s.withdrawable <= 0 && s.held <= 0 && s.manualRefund <= 0)
              _bullet(Icons.info_outline_rounded, 'We are checking what is left to settle.'),
          ],
        ),
      ),
      if (needsForfeit) ...[
        const SizedBox(height: HfSpacing.gap),
        HfCard(
          key: const ValueKey<String>('exit-forfeit-card'),
          color: HfColors.butter,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(s.bankOk ? DeleteCopy.forfeitOther : DeleteCopy.forfeitNoBank, style: HfText.bodyStrong),
              const SizedBox(height: 8),
              Text(
                'You can add and verify a bank account first, or give up ${Money.rupees(forfeit)}.',
                style: HfText.bodyText,
              ),
              const SizedBox(height: 12),
              if (!s.bankOk)
                HfButton(
                  key: const ValueKey<String>('exit-add-bank'),
                  label: DeleteCopy.addBank,
                  kind: HfButtonKind.secondary,
                  onPressed: () => unawaited(context.push(Routes.hostOnboardingAt('payout'))),
                ),
              _ackBox(
                key: const ValueKey<String>('exit-forfeit'),
                label: DeleteCopy.forfeitLabel(Money.rupees(forfeit)),
                value: _forfeit,
                onChanged: (v) => setState(() => _forfeit = v),
              ),
            ],
          ),
        ),
      ],
      const SizedBox(height: HfSpacing.gap),
      HfCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(DeleteCopy.whatHappens, style: HfText.subtitle),
            const SizedBox(height: 12),
            _bullet(Icons.hourglass_bottom_rounded, DeleteCopy.waitTime),
            _bullet(Icons.shield_outlined, DeleteCopy.dataDeleted),
          ],
        ),
      ),
      _readMore(),
      const SizedBox(height: HfSpacing.gap),
      _ackBox(
        key: const ValueKey<String>('delete-ack'),
        label: DeleteCopy.ack,
        value: _ack,
        onChanged: (v) => setState(() => _ack = v),
      ),
      const SizedBox(height: HfSpacing.gap),
      HfButton(
        key: const ValueKey<String>('exit-confirm'),
        label: DeleteCopy.closeButton,
        loading: _busy,
        onPressed: canStart ? () => unawaited(_settleAndClose(s)) : null,
      ),
    ];
  }

  // ---- status of a closing in progress --------------------------------------------------------------

  List<Widget> _statusView(ExitState s) {
    final status = s.exit?.status ?? '';
    final line = status == 'waiting_hold'
        ? DeleteCopy.statusHold
        : status == 'ready'
            ? DeleteCopy.statusReady
            : DeleteCopy.statusPayouts;
    final payout = s.payout;
    final refund = s.refund;
    final heldOn = s.heldReleaseAt;
    return [
      _errorBox(),
      const Text(DeleteCopy.statusTitle, style: HfText.title),
      const SizedBox(height: 8),
      Text(line, key: const ValueKey<String>('exit-status-line'), style: HfText.bodyText),
      const SizedBox(height: HfSpacing.gapLarge),
      if (heldOn != null && status == 'waiting_hold')
        _settlementCard(
          key: const ValueKey<String>('exit-status-hold'),
          icon: Icons.schedule_rounded,
          title: 'Earnings on hold',
          status: 'Released on ${formatDay(heldOn)}',
        ),
      if (payout != null)
        _settlementCard(
          key: const ValueKey<String>('exit-status-payout'),
          icon: Icons.account_balance_rounded,
          title: 'Earnings payout ${Money.rupees(payout.amount)}',
          status: DeleteCopy.payoutStatus(payout.status),
          detail: payout.status == 'paid' && payout.utr != null
              ? 'Bank reference ${payout.utr}'
              : payout.status == 'rejected'
                  ? payout.reason
                  : null,
        ),
      if (refund != null)
        _settlementCard(
          key: const ValueKey<String>('exit-status-refund'),
          icon: Icons.undo_rounded,
          title: 'Token refund ${Money.rupees(refund.amount)}',
          status: DeleteCopy.refundStatus(refund.status),
          detail: refund.status == 'rejected' ? refund.reason : null,
        ),
      const SizedBox(height: HfSpacing.gap),
      HfButton(
        key: const ValueKey<String>('exit-cancel'),
        label: DeleteCopy.cancelClosing,
        kind: HfButtonKind.secondary,
        loading: _busy,
        onPressed: () => unawaited(_cancelClosing()),
      ),
      _readMore(),
    ];
  }

  Widget _settlementCard({
    required Key key,
    required IconData icon,
    required String title,
    required String status,
    String? detail,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: HfSpacing.gap),
      child: HfCard(
        key: key,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: HfColors.orchid),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: HfText.bodyStrong),
                  const SizedBox(height: 2),
                  Text(status, style: HfText.bodyText),
                  if (detail != null && detail.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(detail, style: HfText.note),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ---- deletion scheduled ---------------------------------------------------------------------------

  List<Widget> _scheduledView(int atMs) => [
        _errorBox(),
        const Text(DeleteCopy.scheduledTitle, style: HfText.title),
        const SizedBox(height: 8),
        Text(
          'Your account and data will be deleted on ${formatDay(atMs)}. Until then you can change your mind.',
          key: const ValueKey<String>('deletion-date'),
          style: HfText.bodyText,
        ),
        const SizedBox(height: HfSpacing.gapLarge),
        HfButton(
          key: const ValueKey<String>('deletion-keep'),
          label: DeleteCopy.keepAccount,
          loading: _busy,
          onPressed: () => unawaited(_keepAccount()),
        ),
        const SizedBox(height: 4),
        HfButton(
          key: const ValueKey<String>('deletion-sign-out'),
          label: DeleteCopy.signOut,
          kind: HfButtonKind.text,
          onPressed: () => unawaited(_signOut()),
        ),
        _readMore(),
      ];
}
