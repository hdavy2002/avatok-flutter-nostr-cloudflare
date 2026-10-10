import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../explore/data/host_filters.dart';
import '../../explore/data/host_options.dart';
import '../../explore/data/hosts_repository.dart';

/// The "Online now" strip on Home: `GET /api/hf/hosts?online=1&limit=12`, saved copy first, then fresh.
/// (Same list endpoint and cache logic as Explore, with its own cache key.)
final onlineHostsProvider = StreamProvider.autoDispose<HostListUpdate>(
  retry: noAutoRetry,
  (ref) => ref.watch(hostsRepositoryProvider).firstPage(
        const HostFilters(online: true),
        cacheKey: kOnlineCacheKey,
        limit: 12,
        screen: 'home',
      ),
);
