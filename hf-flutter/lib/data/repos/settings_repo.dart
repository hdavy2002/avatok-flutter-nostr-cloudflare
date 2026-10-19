import 'dart:math';

import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/brand.dart';
import '../api_client.dart';

/// The three WhatsApp switches (`hf_user_prefs`). The words on screen differ from the server keys:
/// Call alerts = [notifyWhatsapp], Booking reminders = [apptReminders], New reels from favourites = [reelAlerts].
class NotifyPrefs {
  const NotifyPrefs({this.notifyWhatsapp = true, this.apptReminders = true, this.reelAlerts = true});

  final bool notifyWhatsapp;
  final bool apptReminders;
  final bool reelAlerts;

  NotifyPrefs copyWith({bool? notifyWhatsapp, bool? apptReminders, bool? reelAlerts}) => NotifyPrefs(
        notifyWhatsapp: notifyWhatsapp ?? this.notifyWhatsapp,
        apptReminders: apptReminders ?? this.apptReminders,
        reelAlerts: reelAlerts ?? this.reelAlerts,
      );

  factory NotifyPrefs.fromJson(Map<String, dynamic> j) => NotifyPrefs(
        notifyWhatsapp: j['notifyWhatsapp'] != false,
        apptReminders: j['apptReminders'] != false,
        reelAlerts: j['reelAlerts'] != false,
      );

  @override
  bool operator ==(Object other) =>
      other is NotifyPrefs && other.notifyWhatsapp == notifyWhatsapp && other.apptReminders == apptReminders && other.reelAlerts == reelAlerts;

  @override
  int get hashCode => Object.hash(notifyWhatsapp, apptReminders, reelAlerts);
}

/// One payout or refund created for a closing account.
class ExitLine {
  const ExitLine({required this.status, this.amount = 0, this.reason, this.utr});

  /// `requested | approved | processing | paid | refunded | rejected | cancelled ...`
  final String status;
  final double amount;
  final String? reason;
  final String? utr;

  bool get isDone => status == 'paid' || status == 'refunded';
  bool get isRejected => status == 'rejected';

  static ExitLine? from(Object? v) {
    if (v is! Map) return null;
    final m = Map<String, dynamic>.from(v);
    final reason = (m['reason'] ?? '').toString().trim();
    final utr = (m['utr'] ?? '').toString().trim();
    return ExitLine(
      status: (m['status'] ?? '').toString(),
      amount: m['amount'] is num ? (m['amount'] as num).toDouble() : 0,
      reason: reason.isEmpty ? null : reason,
      utr: utr.isEmpty ? null : utr,
    );
  }
}

/// `GET /api/hf/account/exit` (worker/src/routes/hf_exit.ts): what closing this account involves right now.
class CloseState {
  const CloseState({
    this.gateEnabled = true,
    this.decision = 'delete',
    this.paidBalance = 0,
    this.withdrawable = 0,
    this.held = 0,
    this.refundable = 0,
    this.manualRefund = 0,
    this.forfeitRupees = 0,
    this.bankOk = false,
    this.exitStatus,
    this.payout,
    this.refund,
    this.deletionScheduledAt,
  });

  final bool gateEnabled;

  /// `delete`: nothing to settle, delete now. `exit`: money must be paid out / refunded first.
  final String decision;
  final double paidBalance;
  final double withdrawable;
  final double held;
  final double refundable;
  final double manualRefund;

  /// Money that would be lost unless a bank account is added (host earnings with no verified bank).
  final double forfeitRupees;
  final bool bankOk;

  /// `booking_cleanup | waiting_hold | waiting_payouts | ready | done | cancelled`, or null when no closure was started.
  final String? exitStatus;
  final ExitLine? payout;
  final ExitLine? refund;

  /// Epoch ms when the account is erased (end of the 30-day grace), or null when no deletion is scheduled.
  final int? deletionScheduledAt;

  bool get mustSettleFirst => decision == 'exit';
  bool get closureActive => const {'booking_cleanup', 'waiting_hold', 'waiting_payouts', 'ready'}.contains(exitStatus);
  bool get deletionScheduled => deletionScheduledAt != null;
  bool get hasMoney => paidBalance > 0 || withdrawable > 0 || held > 0 || refundable > 0 || manualRefund > 0;

  factory CloseState.fromJson(Map<String, dynamic> j) {
    double n(Object? v) => v is num ? v.toDouble() : 0;
    final exit = j['exit'];
    final del = j['deletion'];
    return CloseState(
      gateEnabled: j['gateEnabled'] != false,
      decision: (j['decision'] ?? 'delete').toString() == 'exit' ? 'exit' : 'delete',
      paidBalance: n(j['paidBalance']),
      withdrawable: n(j['withdrawable']),
      held: n(j['held']),
      refundable: n(j['refundable']),
      manualRefund: n(j['manualRefund']),
      forfeitRupees: n(j['forfeitRupees']),
      bankOk: j['bankOk'] == true,
      exitStatus: exit is Map ? (exit['status'] ?? '').toString() : null,
      payout: ExitLine.from(j['payout']),
      refund: ExitLine.from(j['refund']),
      deletionScheduledAt: del is Map && del['scheduledAt'] is num ? (del['scheduledAt'] as num).toInt() : null,
    );
  }
}

/// What the app is, for the About row: "2.0.0 (build 2123)".
class AppVersion {
  const AppVersion(this.version, this.build);
  final String version;
  final String build;

  String get label => build.isEmpty ? version : '$version (build $build)';
}

/// Settings, Help and Delete account (HF-WIRE-11).
///
/// - `GET /api/hf/me/prefs` / `PATCH /api/hf/me/prefs {notifyWhatsapp?, apptReminders?, reelAlerts?}`
/// - `PATCH /api/hf/me {displayName}` (2-40 letters; the server refuses digits and contact details)
/// - `GET /api/hf/account/exit`, `POST /api/hf/account/exit {forfeit?}` (Idempotency-Key), `DELETE /api/hf/account/exit`:
///   pay-out-first closure (HF-PAY-14). The closure itself schedules the deletion once the money is settled.
/// - `POST /api/account/delete` (30-day grace) when there is no money to settle, `POST /api/account/delete/cancel`.
class SettingsRepo {
  const SettingsRepo(this._api);

  final ApiClient _api;

  Future<NotifyPrefs> prefs() async => NotifyPrefs.fromJson(await _api.getJson('/api/hf/me/prefs'));

  /// Saves only the keys given. Returns what the server now holds.
  Future<NotifyPrefs> savePrefs({bool? notifyWhatsapp, bool? apptReminders, bool? reelAlerts}) async {
    final body = <String, Object?>{
      if (notifyWhatsapp != null) 'notifyWhatsapp': notifyWhatsapp,
      if (apptReminders != null) 'apptReminders': apptReminders,
      if (reelAlerts != null) 'reelAlerts': reelAlerts,
    };
    return NotifyPrefs.fromJson(await _api.patchJson('/api/hf/me/prefs', body: body));
  }

  /// Returns the name the server stored.
  Future<String> saveName(String name) async {
    final j = await _api.patchJson('/api/hf/me', body: {'displayName': name.trim()});
    final stored = (j['displayName'] ?? '').toString().trim();
    return stored.isEmpty ? name.trim() : stored;
  }

  Future<CloseState> closeState() async => CloseState.fromJson(await _api.getJson('/api/hf/account/exit'));

  /// Starts the pay-out-first closure. Throws `ApiException` with code `forfeit_required` (extra.forfeitRupees),
  /// `bank_required`, `active_call` or `nothing_to_settle`.
  Future<void> startClosure({bool forfeit = false}) async {
    await _api.request(
      'POST',
      '/api/hf/account/exit',
      body: {if (forfeit) 'forfeit': true},
      headers: {'Idempotency-Key': _key()},
    );
  }

  /// Only possible while nothing has been approved or paid (else 409 `cannot_cancel`).
  Future<void> cancelClosure() async {
    await _api.deleteJson('/api/hf/account/exit');
  }

  /// No money to settle: schedules the deletion with the 30-day grace. Returns the end of the grace (epoch ms).
  Future<int?> deleteNow() async {
    final j = await _api.postJson('/api/account/delete');
    final v = j['grace_ends_at'];
    return v is num ? v.toInt() : null;
  }

  Future<void> cancelDeletion() async {
    await _api.postJson('/api/account/delete/cancel');
  }

  static String _key() {
    final r = Random.secure();
    final tail = List.generate(8, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
    return 'app-${DateTime.now().millisecondsSinceEpoch}-$tail';
  }
}

/// Opens web pages (Custom Tab) and the mail app. Tests replace [launcher].
abstract final class ExternalLinks {
  static Future<bool> Function(Uri url) launcher = _launch;

  /// The real website pages, built from the brand domain (never a literal).
  static Uri get terms => Uri.parse(Brand.url('/terms'));
  static Uri get privacy => Uri.parse(Brand.url('/privacy'));
  static Uri get dataDeletion => Uri.parse(Brand.url('/data-deletion'));
  static Uri get supportMail => Uri(scheme: 'mailto', path: Brand.supportEmail);

  static Future<bool> open(Uri uri) async {
    try {
      return await launcher(uri);
    } catch (_) {
      return false;
    }
  }

  static Future<bool> _launch(Uri uri) => launchUrl(
        uri,
        mode: uri.scheme == 'mailto' ? LaunchMode.externalApplication : LaunchMode.inAppBrowserView,
      );
}

/// The installed version. Tests replace [loader].
abstract final class AppVersionInfo {
  static Future<AppVersion> Function() loader = _load;

  static Future<AppVersion> load() async {
    try {
      return await loader();
    } catch (_) {
      return const AppVersion('', '');
    }
  }

  static Future<AppVersion> _load() async {
    final info = await PackageInfo.fromPlatform();
    return AppVersion(info.version, info.buildNumber);
  }
}
