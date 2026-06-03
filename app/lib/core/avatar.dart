import 'package:flutter/material.dart';

import 'theme.dart';

/// Deterministic gradient avatar with initials (matches the mockup's generated
/// avatars). Replace with real profile images (kind 0 metadata) later.
class Avatar extends StatelessWidget {
  final String seed;
  final String name;
  final double size;
  const Avatar({super.key, required this.seed, required this.name, this.size = 44});

  int get _g {
    var h = 0;
    for (final c in seed.codeUnits) {
      h = (h * 31 + c) & 0x7fffffff;
    }
    return h % AvaColors.thumbGradients.length;
  }

  String get _initials {
    final parts = name.trim().split(' ').where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
    return (parts.first.substring(0, 1) + parts.last.substring(0, 1)).toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        gradient: AvaColors.thumbGradients[_g],
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: Text(_initials,
          style: TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.w800,
              fontSize: size * 0.38)),
    );
  }
}
