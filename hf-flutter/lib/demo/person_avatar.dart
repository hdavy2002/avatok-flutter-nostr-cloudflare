import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../data/repos/my_photos_repo.dart';
import '../ui/net_image.dart';
import 'theme.dart';

/// [HF-ME-SETTINGS-MOVE] A round picture of a person: their photo (kept on the phone by [NetImage]), or the first letter of their
/// name on the rani-to-marigold circle while there is no photo, while it loads and if it fails.
class PersonAvatar extends StatelessWidget {
  const PersonAvatar({super.key, required this.name, this.url, this.size = 44, this.border = false});

  final String name;
  final String? url;
  final double size;

  /// A white ring, as on the Settings strip.
  final bool border;

  @override
  Widget build(BuildContext context) {
    final n = name.trim();
    final initial = n.isEmpty ? '?' : String.fromCharCode(n.runes.first).toUpperCase();
    final fallback = Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        shape: BoxShape.circle,
        gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.rani, C.marigold]),
      ),
      child: Text(initial, style: t(size * .4, color: C.white, w: FontWeight.w900)),
    );
    final u = (url ?? '').trim();
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(shape: BoxShape.circle, border: border ? Border.all(color: C.white, width: 3) : null),
      child: ClipOval(child: u.isEmpty ? fallback : NetImage(u, fallback: fallback)),
    );
  }
}

/// [HF-ME-SETTINGS-MOVE] The signed-in person's approved profile photo, from `GET /api/hf/me/photos`.
/// `GET /api/hf/me` does not carry the picture, so the Settings strip used to have nothing to show but the initial.
/// Anything that shows "my picture" listens to [url] and calls [refresh] when it opens.
abstract final class MyProfilePhoto {
  static final ValueNotifier<String?> url = ValueNotifier<String?>(null);

  /// Reads the photo again. A failure (including the feature being switched off) keeps what is already known.
  static Future<void> refresh() async {
    try {
      final p = await MyPhotosRepo.instance.load();
      final u = p.profile.url;
      url.value = (u == null || u.isEmpty) ? null : u;
    } catch (_) {
      // keep the last known picture; the initial shows when there is none
    }
  }

  /// Forget it on sign-out so the next account never sees this picture.
  static void clear() => url.value = null;
}
