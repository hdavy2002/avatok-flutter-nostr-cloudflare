
import '../../core/localization/ui_text.dart';
import 'virtual_numbers_models.dart';

/// Sponsor-demo fixtures used until the telephony provider is connected.
/// These never create, reserve, or charge for a real number.
class VirtualNumbersDemo {
  static final lines = <VirtualLine>[
    VirtualLine(
      id: 'demo-did-business',
      label: uiCopy(UiMessage.m_avatok_business_67f9056a27),
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
     VirtualLine(
      id: 'demo-avatok-family',
      label: uiCopy(UiMessage.m_family_friends_761ee4de39),
      kind: VirtualLineKind.avatok,
      canonicalNumber: 'AVA-2026-8188',
      displayNumber: 'AVA 2026 8188',
      colorKey: 'blue',
      capabilities: {'voice': true, 'messaging': true, 'recording': true},
      unreadCount: 2,
    ),
     VirtualLine(
      id: 'demo-did-india',
      label: uiCopy(UiMessage.m_india_office_b650866560),
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
        title: uiCopy(UiMessage.m_priya_sharma_188492b7d2),
        subtitle: uiCopy(UiMessage.m_incoming_call_answered_by_ava_830632cbf9),
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
        title: uiCopy(UiMessage.m_verification_code_482_913_6c948d82b5),
        subtitle: uiCopy(UiMessage.m_your_one_time_code_expires_e4f1a10729),
        direction: 'incoming',
        occurredAt: now.subtract(const Duration(hours: 1)),
        unread: true,
      ),
      VirtualLineActivity(
        id: '$lineId-sms',
        type: VirtualActivityType.textMessages,
        title: uiCopy(UiMessage.m_delivery_partner_cb946ef0d3),
        subtitle: uiCopy(UiMessage.m_your_parcel_will_arrive_between_d5bf7570be),
        direction: 'incoming',
        occurredAt: now.subtract(const Duration(hours: 3)),
      ),
      VirtualLineActivity(
        id: '$lineId-receptionist',
        type: VirtualActivityType.receptionist,
        title: uiCopy(UiMessage.m_ava_receptionist_summary_cdbd0b049e),
        subtitle: uiCopy(UiMessage.m_qualified_a_new_sponsor_lead_7dcad7a716),
        direction: 'incoming',
        occurredAt: now.subtract(const Duration(days: 1)),
        durationSeconds: 87,
        hasRecording: true,
        recordingRef: 'demo-receptionist-recording',
      ),
    ];
  }
}
