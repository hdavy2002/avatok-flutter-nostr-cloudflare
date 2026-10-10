import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/widgets/widgets.dart';
import '../data/kyc_telemetry.dart';
import '../data/permission_service.dart';

/// Permission flow of spec 2.13, in one widget:
///
///   explainer ("why we need it")  ->  Android prompt  ->  granted: [child]
///                                                     ->  denied: explainer with "Open settings"
///
/// When every permission is already granted the explainer is skipped and [child] shows at once. After a denial
/// the person goes to the system settings; when the app comes back (resume) the gate checks again and opens
/// [child] by itself if it is allowed now.
///
/// Telemetry: one `hf_app_permission {kind, result}` per Android prompt (`granted | denied | error`).
///
/// Part B uses it for the microphone: `PermissionGate(permissions: [HfPermission.mic], ...)`.
class PermissionGate extends ConsumerStatefulWidget {
  const PermissionGate({
    super.key,
    required this.permissions,
    required this.icon,
    required this.title,
    required this.body,
    required this.child,
    this.onSkip,
  });

  final List<HfPermission> permissions;
  final IconData icon;
  final String title;

  /// The "why" shown before the Android prompt.
  final String body;

  /// Built only when every permission is granted.
  final Widget child;

  /// Adds a "Not now" button when set.
  final VoidCallback? onSkip;

  @override
  ConsumerState<PermissionGate> createState() => _PermissionGateState();
}

enum _Gate { checking, explain, requesting, denied, granted }

class _PermissionGateState extends ConsumerState<PermissionGate> with WidgetsBindingObserver {
  _Gate _state = _Gate.checking;

  PermissionService get _service => ref.read(permissionServiceProvider);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_check());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _state == _Gate.denied) unawaited(_check());
  }

  Future<bool> _allGranted() async {
    for (final p in widget.permissions) {
      if (!await _service.isGranted(p)) return false;
    }
    return true;
  }

  Future<void> _check() async {
    final ok = await _allGranted();
    if (!mounted) return;
    setState(() => _state = ok ? _Gate.granted : (_state == _Gate.denied ? _Gate.denied : _Gate.explain));
  }

  Future<void> _allow() async {
    setState(() => _state = _Gate.requesting);
    try {
      for (final p in widget.permissions) {
        if (await _service.isGranted(p)) continue;
        final r = await _service.request(p);
        KycTelemetry.permission(p.name, r == HfPermissionResult.granted ? 'granted' : 'denied');
        if (r != HfPermissionResult.granted) {
          if (mounted) setState(() => _state = _Gate.denied);
          return;
        }
      }
      if (mounted) setState(() => _state = _Gate.granted);
    } catch (_) {
      for (final p in widget.permissions) {
        KycTelemetry.permission(p.name, 'error');
      }
      if (mounted) setState(() => _state = _Gate.denied);
    }
  }

  @override
  Widget build(BuildContext context) {
    switch (_state) {
      case _Gate.granted:
        return widget.child;
      case _Gate.checking:
      case _Gate.requesting:
        return const Padding(padding: EdgeInsets.all(24), child: LoadingPanel());
      case _Gate.explain:
      case _Gate.denied:
        return PermissionExplainer(
          icon: widget.icon,
          title: widget.title,
          body: _state == _Gate.denied ? _deniedBody : widget.body,
          denied: _state == _Gate.denied,
          onAllow: _allow,
          onOpenSettings: () => unawaited(_service.openSettings()),
          onSkip: widget.onSkip,
        );
    }
  }

  String get _deniedBody =>
      'This is turned off for the app. Open settings, tap Permissions, turn it on, then come back here.';
}
