import 'package:flutter/material.dart';

import '../data/models/reel.dart';
import 'data.dart';
import 'theme.dart';

/// Joins real reels (HF-WIRE-4) to the screens that still speak the dummy [Influencer] / [Reel] types.
const List<Color> _realTones = [C.violet, C.maroon];

String compactCount(int n) {
  if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
  if (n >= 1000) return '${(n / 1000).toStringAsFixed(n >= 10000 ? 0 : 1)}K';
  return '$n';
}

/// An [Influencer] for the call / booking flows and the Avatar widget. `id` is the SLUG: that is what the call routes take.
Influencer influencerFromHost(ReelHost h, {String bio = '', int likes = 0, int videos = 0}) => Influencer(
      id: h.slug,
      name: h.name,
      handle: h.handle ?? '',
      city: '',
      niche: '',
      bio: bio,
      rate: h.rateRupees,
      likes: compactCount(likes),
      followers: compactCount(h.followers),
      videos: videos,
      online: h.online,
      tones: _realTones,
      avatarUrl: h.avatar,
    );

/// A dummy-typed [Reel] wrapping a real one, so [ReelPage] keeps one layout.
Reel demoReelFrom(FeedReel r) => Reel(id: r.id, who: influencerFromHost(r.host), caption: r.caption, views: compactCount(r.views), hearts: r.likes);
