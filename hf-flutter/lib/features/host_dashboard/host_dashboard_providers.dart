import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/session.dart';
import 'data/host_dashboard_api.dart';
import 'data/host_dashboard_models.dart';

/// The dashboard's typed API. Tests override [apiClientProvider] with a FakeApiClient.
final hostDashboardApiProvider = Provider<HostDashboardApi>((ref) => HostDashboardApi(ref.watch(apiClientProvider)));

/// How often an online host in the foreground sends a beat. The server's limit is 8 hours.
final presenceBeatIntervalProvider = Provider<Duration>((ref) => const Duration(minutes: 5));

/// The clock for hold dates ("available on 14 Oct"). Tests pin it.
final dashboardClockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// Money and status are never cached: each of these reads the server live, every time the tab opens.
final hostProfileStatusProvider =
    FutureProvider.autoDispose<HostProfileStatus>((ref) => ref.watch(hostDashboardApiProvider).profile());

final hostPresenceProvider = FutureProvider.autoDispose<String>((ref) => ref.watch(hostDashboardApiProvider).presence());

final hostCallsProvider = FutureProvider.autoDispose<HostCallsData>((ref) => ref.watch(hostDashboardApiProvider).calls());

final hostEarningsProvider =
    FutureProvider.autoDispose<HostEarnings?>((ref) => ref.watch(hostDashboardApiProvider).earnings());

final hostPayoutsProvider = FutureProvider.autoDispose<PayoutsData>((ref) => ref.watch(hostDashboardApiProvider).payouts());

/// The value of an [AsyncValue] when it has one (also while reloading), else null. Never throws.
T? dashValueOf<T>(AsyncValue<T> v) => v.hasValue ? v.requireValue : null;
