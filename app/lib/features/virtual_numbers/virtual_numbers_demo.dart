import 'virtual_numbers_models.dart';

/// Sponsor-demo fixtures used until the telephony provider is connected.
/// These never create, reserve, or charge for a real number.
class VirtualNumbersDemo {
  static final lines = <VirtualLine>[
    VirtualLine(
      id: 'demo-did-business',
      label: 'AvaTOK Business',
      kind: VirtualLineKind.did,
      canonicalNumber: '+14155550148',
      displayNumber: '+1 (415) 555-0148',
      countryIso2: 'US',
      region: 'San Francisco, CA',
      colorKey: 'pink',
      capabilities: const {
        'voice': true,
        'sms': true,
        'otp': true,
        'recording': true,
        'outbound_caller_id': true,
      },
      isDefaultOutgoing: true,
      unreadCount: 4,
      monthlyTokens: 600,
      provider: 'Demo provider',
    ),
    const VirtualLine(
      id: 'demo-avatok-family',
      label: 'Family & friends',
      kind: VirtualLineKind.avatok,
      canonicalNumber: 'AVA-2026-8188',
      displayNumber: 'AVA 2026 8188',
      colorKey: 'blue',
      capabilities: {'voice': true, 'messaging': true, 'recording': true},
      unreadCount: 2,
    ),
    const VirtualLine(
      id: 'demo-did-india',
      label: 'India office',
      kind: VirtualLineKind.did,
      canonicalNumber: '+911155501926',
      displayNumber: '+91 11 5550 1926',
      countryIso2: 'IN',
      region: 'New Delhi',
      colorKey: 'teal',
      capabilities: {
        'voice': true,
        'sms': true,
        'recording': true,
        'outbound_caller_id': true,
      },
      unreadCount: 1,
      monthlyTokens: 600,
      provider: 'Demo provider',
    ),
  ];

  static List<VirtualLineActivity> activity(String lineId) {
    final now = DateTime.now();
    return [
      VirtualLineActivity(
        id: '$lineId-call',
        type: VirtualActivityType.calls,
        title: 'Priya Sharma',
        subtitle: 'Incoming call answered by Ava',
        direction: 'incoming',
        occurredAt: now.subtract(const Duration(minutes: 18)),
        durationSeconds: 194,
        unread: true,
        hasRecording: true,
        recordingRef: 'demo-recording',
        transcript: 'Hi, I am calling about tomorrow’s product demonstration.',
      ),
      VirtualLineActivity(
        id: '$lineId-otp',
        type: VirtualActivityType.otp,
        title: 'Verification code · 482 913',
        subtitle: 'Your one-time code expires in 10 minutes',
        direction: 'incoming',
        occurredAt: now.subtract(const Duration(hours: 1)),
        unread: true,
      ),
      VirtualLineActivity(
        id: '$lineId-sms',
        type: VirtualActivityType.textMessages,
        title: 'Delivery partner',
        subtitle: 'Your parcel will arrive between 2–4 PM.',
        direction: 'incoming',
        occurredAt: now.subtract(const Duration(hours: 3)),
      ),
      VirtualLineActivity(
        id: '$lineId-receptionist',
        type: VirtualActivityType.receptionist,
        title: 'Ava receptionist summary',
        subtitle: 'Qualified a new sponsor lead and requested a callback.',
        direction: 'incoming',
        occurredAt: now.subtract(const Duration(days: 1)),
        durationSeconds: 87,
        hasRecording: true,
        recordingRef: 'demo-receptionist-recording',
      ),
    ];
  }
}
