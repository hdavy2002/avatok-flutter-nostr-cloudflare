import 'package:flutter/foundation.dart';

import 'data.dart';

/// All demo state lives in memory. Restarting the app resets it. No backend, no storage.
class DemoState extends ChangeNotifier {
  DemoState() {
    final today = dayOnly(DateTime.now());
    // The influencer's own open days: the next 12 days except Sundays, four slots each.
    for (var i = 0; i < 12; i++) {
      final d = today.add(Duration(days: i));
      if (d.weekday == DateTime.sunday) continue;
      availability[dayKey(d)] = {'10:00 am', '4:00 pm', '6:00 pm', '8:00 pm'};
    }
    // Fans who booked the influencer (demo).
    inBookings.addAll([
      InBooking('Tara S.', today, '6:00 pm', 10, 'Wants tips on a Jaipur trip'),
      InBooking('Rahul M.', today.add(const Duration(days: 1)), '10:00 am', 10, 'First call'),
      InBooking('Neha K.', today.add(const Duration(days: 1)), '8:00 pm', 15, 'Follow-up from last week'),
      InBooking('Imran A.', today.add(const Duration(days: 3)), '4:00 pm', 10, ''),
      InBooking('Pooja R.', today.add(const Duration(days: 6)), '6:00 pm', 10, 'Birthday surprise call'),
    ]);
  }

  // Influencer calendar
  final Map<String, Set<String>> availability = {};
  final List<InBooking> inBookings = [];

  Set<String> slotsOn(DateTime d) => availability[dayKey(d)] ?? <String>{};

  void toggleSlot(DateTime d, String slot) {
    final set = availability.putIfAbsent(dayKey(d), () => <String>{});
    if (!set.remove(slot)) set.add(slot);
    if (set.isEmpty) availability.remove(dayKey(d));
    notifyListeners();
  }

  void setDayOpen(DateTime d, bool open) {
    if (open) {
      availability[dayKey(d)] = {'10:00 am', '4:00 pm', '6:00 pm', '8:00 pm'};
    } else {
      availability.remove(dayKey(d));
    }
    notifyListeners();
  }

  List<InBooking> bookingsOn(DateTime d) => inBookings.where((b) => dayKey(b.day) == dayKey(d)).toList();

  bool introSeen = false;

  // Fan account
  bool signedIn = false;
  String name = '';
  String email = '';
  String whatsapp = '';

  // Influencer side
  bool influencerJoined = false;
  bool online = true;
  int myRate = 20;
  final Set<int> availableDays = {0, 1, 2, 3, 4};
  String fromTime = '10:00 am';
  String toTime = '9:00 pm';
  double earningsReady = 2340;
  double earningsHold = 860;

  // Money
  double balance = 1240.50;
  final List<Txn> txns = [
    Txn('Call · Meera Joshi', 'Today, 6:42 pm · 3 min', -45),
    Txn('Top up', 'Today, 6:30 pm · ₹500 paid incl. GST', 423.72),
    Txn('Booking held · Arjun Rao', 'Thu 23, 4:00 pm · 10 min', -200),
    Txn('Call · Rohan Mehta', 'Mon, 9:10 pm · 7 min', -175),
    Txn('Top up', 'Mon, 9:02 pm · ₹1,200 paid incl. GST', 1016.95),
  ];
  final List<PayoutReq> payouts = [
    PayoutReq('12 Oct', 1500, 'PAID · UTR 4521…'),
  ];

  // Activity
  final Set<String> favs = {'r3', 'r4'};
  late final List<CallRecord> calls = [
    CallRecord(influencers[0], 'Today, 6:42 pm', 3, 45, stars: 5),
    CallRecord(influencers[3], 'Mon, 9:10 pm', 7, 175, stars: 4),
    CallRecord(influencers[2], 'Sat, 8:05 pm', 12, 216, stars: 5),
  ];
  late final List<Booking> bookings = [
    Booking(influencers[1], 'Thu 23', '4:00 pm', 200),
  ];
  final Map<String, int> votes = {
    '@chai_with_chacha': 1240,
    '@desi.dance.didi': 860,
    '@techwithtanya': 412,
    '@pahadi.vlogs': 97,
  };
  final Set<String> myVotes = {};

  void finishIntro() {
    introSeen = true;
    notifyListeners();
  }

  void signUp(String n, String e, String w) {
    signedIn = true;
    name = n.trim().isEmpty ? 'Friend' : n.trim();
    email = e.trim();
    whatsapp = w.trim();
    notifyListeners();
  }

  void signOut() {
    signedIn = false;
    influencerJoined = false;
    notifyListeners();
  }

  bool isFav(String reelId) => favs.contains(reelId);

  void toggleFav(String reelId) {
    if (!favs.remove(reelId)) favs.add(reelId);
    notifyListeners();
  }

  int votesFor(String handle) => votes[handle] ?? 0;

  void vote(String handle) {
    if (myVotes.contains(handle)) return;
    myVotes.add(handle);
    votes[handle] = votesFor(handle) + 1;
    notifyListeners();
  }

  /// Paid amount includes 18% GST: the wallet gets paid ÷ 1.18, rounded down to the paisa.
  static double creditFor(double paid) => (paid / 1.18 * 100).floorToDouble() / 100;

  void topUp(double paid) {
    final credit = creditFor(paid);
    balance += credit;
    txns.insert(0, Txn('Top up', 'Just now · ₹${paid.toStringAsFixed(0)} paid incl. GST', credit));
    notifyListeners();
  }

  void recordCall(Influencer who, int seconds) {
    final minutes = seconds <= 0 ? 0 : (seconds / 60).ceil();
    final cost = (minutes * who.rate).toDouble();
    balance -= cost;
    calls.insert(0, CallRecord(who, 'Just now', minutes, cost));
    txns.insert(0, Txn('Call · ${who.name}', 'Just now · $minutes min', -cost));
    notifyListeners();
  }

  void rateLastCall(int stars) {
    if (calls.isNotEmpty) calls.first.stars = stars;
    notifyListeners();
  }

  void book(Influencer who, String day, String time) {
    final hold = (who.rate * 10).toDouble();
    balance -= hold;
    bookings.insert(0, Booking(who, day, time, hold));
    txns.insert(0, Txn('Booking held · ${who.name}', '$day, $time · 10 min', -hold));
    notifyListeners();
  }

  void cancelBooking(Booking b) {
    bookings.remove(b);
    balance += b.hold;
    txns.insert(0, Txn('Booking cancelled · ${b.who.name}', 'Hold returned', b.hold));
    notifyListeners();
  }

  void requestPayout(double amount) {
    earningsReady -= amount;
    payouts.insert(0, PayoutReq('Today', amount, 'BEING CHECKED'));
    notifyListeners();
  }

  void joinAsInfluencer() {
    influencerJoined = true;
    online = true;
    notifyListeners();
  }

  void setOnline(bool v) {
    online = v;
    notifyListeners();
  }

  void setRate(int r) {
    myRate = r.clamp(1, 500);
    notifyListeners();
  }

  void toggleDay(int d) {
    if (!availableDays.remove(d)) availableDays.add(d);
    notifyListeners();
  }

  void setHours(String from, String to) {
    fromTime = from;
    toTime = to;
    notifyListeners();
  }
}

final demo = DemoState();
