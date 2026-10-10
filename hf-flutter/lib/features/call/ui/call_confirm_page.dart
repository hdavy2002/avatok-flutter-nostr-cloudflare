import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/strings.dart';
import '../../../core/widgets/widgets.dart';
import '../data/call_api.dart';
import 'call_confirm_sheet.dart';

/// `/call/new?host=<slug>[&lane=lgbtq]`: the call confirm step as a page. The host profile opens this route
/// (its default call opener), so the confirm step works without a bottom sheet. Same content as
/// [CallConfirmSheet]. When the call starts, this page is replaced by `/call/<id>`.
class CallConfirmPage extends ConsumerWidget {
  const CallConfirmPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final query = GoRouterState.of(context).uri.queryParameters;
    final slug = (query['host'] ?? '').trim().toLowerCase();
    // women-lane hosts are lane-set by the server: only the LGBTQ+ lane is ever sent from here
    final lane = query['lane'] == 'lgbtq' ? 'lgbtq' : null;
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        leading: const HfBackButton(),
        title: const Text('Start a call'),
      ),
      body: SafeArea(child: slug.isEmpty ? _noHost(context) : _confirm(context, ref, slug, lane)),
    );
  }

  Widget _noHost(BuildContext context) => EmptyPanel(
        message: 'Choose someone to call first.',
        icon: Icons.person_search_rounded,
        actionLabel: Strings.tabExplore,
        onAction: () => GoRouter.of(context).go(Routes.explore),
      );

  Widget _confirm(BuildContext context, WidgetRef ref, String slug, String? lane) {
    final name = ref.watch(callHostNameProvider(slug));
    return name.when(
      loading: () => const LoadingPanel(),
      error: (_, __) => _sheet(context, slug, '', lane),
      data: (n) => _sheet(context, slug, n, lane),
    );
  }

  Widget _sheet(BuildContext context, String slug, String name, String? lane) {
    final router = GoRouter.of(context);
    return CallConfirmSheet(
      slug: slug,
      hostName: name,
      lane: lane,
      showHandle: false,
      onOutcome: (o) {
        if (o.action == CallSheetAction.close) {
          popOrHome(context);
        } else {
          unawaited(handleCallSheetOutcome(router, o, replace: true));
        }
      },
    );
  }
}
