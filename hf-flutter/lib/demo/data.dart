import 'package:flutter/material.dart';

import '../data/models/queue.dart';

/// DEMO DATA ONLY. Nothing here talks to the backend yet (owner, 2026-10-19:
/// screens first, wiring later). Every name below is invented.
class Influencer {
  const Influencer({
    required this.id,
    required this.name,
    required this.handle,
    required this.city,
    required this.niche,
    required this.bio,
    required this.rate,
    required this.likes,
    required this.followers,
    required this.videos,
    required this.online,
    required this.tones,
    this.portrait,
    this.avatarUrl,
    this.callState,
    this.queueOpen = false,
    this.queueWaiting = 0,
  });

  /// [HF-CALL-MODES-E2] What a fan sees (spec 2.1), when the server sent it. Null = behave as before (online / offline).
  final HostCallState? callState;
  final bool queueOpen;
  final int queueWaiting;

  final String id;
  final String name;
  final String handle;
  final String city;
  final String niche;
  final String bio;
  final int rate; // rupees per minute
  final String likes;
  final String followers;
  final int videos;
  final bool online;
  final List<Color> tones;

  /// Art path under assets/images/bazaar/ (optional).
  final String? portrait;

  /// A real photo from the server (HF-WIRE-4); wins over [portrait].
  final String? avatarUrl;

  String get initials =>
      name.split(' ').where((p) => p.isNotEmpty).map((p) => p[0]).take(2).join();
}

class Reel {
  const Reel({
    required this.id,
    required this.who,
    required this.caption,
    required this.views,
    required this.hearts,
  });

  final String id;
  final Influencer who;
  final String caption;
  final String views;
  final int hearts;
}

const influencers = <Influencer>[
  Influencer(
    id: 'meera',
    name: 'Meera Joshi',
    handle: '@meera.cooks',
    city: 'Indore',
    niche: 'Home cooking',
    bio: 'Home cook, 10-minute recipes. Call me for kitchen doubts, tiffin ideas or just a chat.',
    rate: 15,
    likes: '1.2M',
    followers: '212K',
    videos: 148,
    online: true,
    tones: [Color(0xFFFF8A1F), Color(0xFFC2185B)],
    portrait: 'profile/demo-meera.webp',
  ),
  Influencer(
    id: 'arjun',
    name: 'Arjun Rao',
    handle: '@arjun.lifts',
    city: 'Bengaluru',
    niche: 'Fitness',
    bio: 'Fitness coach. Ask me about home workouts, diet on a budget and staying consistent.',
    rate: 20,
    likes: '860K',
    followers: '154K',
    videos: 96,
    online: true,
    tones: [Color(0xFF14A9C4), Color(0xFF7B2FBE)],
    portrait: 'profile/demo-arjun.webp',
  ),
  Influencer(
    id: 'priya',
    name: 'Priya Nair',
    handle: '@priya.wanders',
    city: 'Kochi',
    niche: 'Travel',
    bio: 'Budget travel across India. Plan your next trip with me, one call at a time.',
    rate: 18,
    likes: '540K',
    followers: '98K',
    videos: 211,
    online: true,
    tones: [Color(0xFF7B2FBE), Color(0xFF14A9C4)],
    portrait: 'profile/demo-priya.webp',
  ),
  Influencer(
    id: 'rohan',
    name: 'Rohan Mehta',
    handle: '@rohan.jokes',
    city: 'Mumbai',
    niche: 'Stand-up comedy',
    bio: 'Stand-up comic. Bad day? Call me, I promise at least one good joke.',
    rate: 25,
    likes: '2.4M',
    followers: '480K',
    videos: 320,
    online: true,
    tones: [Color(0xFFFF2E7A), Color(0xFFFF8A1F)],
  ),
  Influencer(
    id: 'kabir',
    name: 'Kabir Khan',
    handle: '@kabir.plays',
    city: 'Delhi',
    niche: 'Gaming',
    bio: 'Mobile gaming tips and squad strategy. Let us talk game plans.',
    rate: 12,
    likes: '1.9M',
    followers: '305K',
    videos: 410,
    online: true,
    tones: [Color(0xFF0B6F86), Color(0xFF7B2FBE)],
  ),
  Influencer(
    id: 'vikram',
    name: 'Vikram Singh',
    handle: '@coach.vikram',
    city: 'Jaipur',
    niche: 'Cricket coaching',
    bio: 'Cricket coach for 15 years. Batting doubts, fitness for young players, selection tips.',
    rate: 30,
    likes: '410K',
    followers: '76K',
    videos: 88,
    online: true,
    tones: [Color(0xFFFFC21A), Color(0xFFD81B4A)],
  ),
  Influencer(
    id: 'simran',
    name: 'Simran Kaur',
    handle: '@simran.glows',
    city: 'Amritsar',
    niche: 'Makeup',
    bio: 'Everyday makeup for Indian skin. Book me for a quick routine check.',
    rate: 22,
    likes: '1.1M',
    followers: '190K',
    videos: 175,
    online: false,
    tones: [Color(0xFFFF2E7A), Color(0xFF7B2FBE)],
    portrait: 'profile/demo-simran.webp',
  ),
  Influencer(
    id: 'ananya',
    name: 'Ananya Iyer',
    handle: '@ananya.sings',
    city: 'Chennai',
    niche: 'Carnatic music',
    bio: 'Carnatic vocalist. Talk to me about learning music as an adult.',
    rate: 28,
    likes: '330K',
    followers: '61K',
    videos: 64,
    online: false,
    tones: [Color(0xFF14A9C4), Color(0xFFC2185B)],
    portrait: 'profile/demo-ananya.webp',
  ),
];

Influencer influencerById(String id) =>
    influencers.firstWhere((i) => i.id == id, orElse: () => influencers.first);

final reels = <Reel>[
  Reel(id: 'r1', who: influencers[0], caption: 'Dal tadka in 10 minutes. Ask me your kitchen doubts!', views: '82K', hearts: 4100),
  Reel(id: 'r2', who: influencers[1], caption: 'No gym? No problem. 15 minutes, one dupatta, full workout.', views: '41K', hearts: 2900),
  Reel(id: 'r3', who: influencers[2], caption: 'Munnar on ₹3,000. Yes, really. Call me for the plan.', views: '1.1M', hearts: 18200),
  Reel(id: 'r4', who: influencers[3], caption: 'When your mummy finds your Instagram.', views: '310K', hearts: 22400),
  Reel(id: 'r5', who: influencers[4], caption: 'Three landing spots nobody checks. Squad up?', views: '230K', hearts: 9800),
  Reel(id: 'r6', who: influencers[5], caption: 'Front-foot drive: the one fix every young batter needs.', views: '64K', hearts: 3300),
  Reel(id: 'r7', who: influencers[0], caption: 'Leftover roti chips. Kids will finish the box.', views: '120K', hearts: 7600),
  Reel(id: 'r8', who: influencers[3], caption: 'Indian uncles at a wedding buffet. A documentary.', views: '890K', hearts: 41000),
  Reel(id: 'r9', who: influencers[6], caption: 'Five-minute office look for humid days.', views: '210K', hearts: 12000),
  Reel(id: 'r10', who: influencers[7], caption: 'Sa Re Ga Ma, the right way to warm up.', views: '33K', hearts: 2100),
];

Reel reelById(String id) => reels.firstWhere((r) => r.id == id, orElse: () => reels.first);

/// Fictional handles that are "not on the app" yet, for the Search + Invite demo.
const notOnNetwork = <String>['@chai_with_chacha', '@desi.dance.didi', '@techwithtanya', '@pahadi.vlogs'];

class Txn {
  Txn(this.title, this.sub, this.amount);
  final String title;
  final String sub;
  final double amount;
}

class CallRecord {
  CallRecord(this.who, this.when, this.minutes, this.cost, {this.stars = 0});
  final Influencer who;
  final String when;
  final int minutes;
  final double cost;
  int stars;
}

class Booking {
  Booking(this.who, this.day, this.time, this.hold);
  final Influencer who;
  final String day;
  final String time;
  final double hold;
}

class PayoutReq {
  PayoutReq(this.when, this.amount, this.status);
  final String when;
  final double amount;
  final String status; // 'PAID · UTR 4521…' or 'BEING CHECKED'
}

/// Bookings the influencer sees on their dashboard (demo).
const influencerUpcoming = <(String, String)>[
  ('Tara S.', 'Today, 6:30 pm · 10 min'),
  ('Rahul M.', 'Tomorrow, 11:00 am · 10 min'),
  ('Neha K.', 'Thu, 4:00 pm · 10 min'),
];

// ------------------------------------------------------------------------------------------- dates

const weekdayShort = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

DateTime dayOnly(DateTime d) => DateTime(d.year, d.month, d.day);
String dayKey(DateTime d) => '${d.year}-${d.month}-${d.day}';

/// "Thu 23 Oct"
String dayLabel(DateTime d) => '${weekdayShort[d.weekday - 1]} ${d.day} ${monthShort[d.month - 1]}';

/// Time slots an influencer can be booked in (one list for the whole demo).
const allSlots = ['9:00 am', '10:00 am', '11:00 am', '12:00 pm', '2:00 pm', '4:00 pm', '6:00 pm', '7:00 pm', '8:00 pm', '9:00 pm', '10:00 pm'];

/// Demo availability of the OTHER influencers (fans book them). Deterministic so it looks real.
List<String> slotsFor(Influencer who, DateTime day) {
  final seed = who.id.codeUnits.fold<int>(0, (a, b) => a + b) + day.day + day.month * 31;
  if (day.weekday == DateTime.sunday || seed % 5 == 0) return const [];
  return [for (var i = 0; i < allSlots.length; i++) if ((seed + i * 3) % 4 != 0) allSlots[i]];
}

/// A fan's booking with the influencer using the app (influencer side).
class InBooking {
  InBooking(this.fan, this.day, this.time, this.minutes, this.note);
  final String fan;
  final DateTime day;
  final String time;
  final int minutes;
  final String note;
}
