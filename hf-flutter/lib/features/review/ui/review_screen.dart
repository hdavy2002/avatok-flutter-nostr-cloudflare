import 'package:flutter/material.dart';

import '../../../core/widgets/widgets.dart';

/// `/review/call/:id` (signed in, from the call screen) and `/review/:token` (no sign-in, from a push or a
/// WhatsApp link). Built in HF-NATIVE-5. Exactly one of [callId] and [token] is set.
class ReviewScreen extends StatelessWidget {
  const ReviewScreen({super.key, this.callId, this.token});

  final String? callId;
  final String? token;

  @override
  Widget build(BuildContext context) => StubScreen(
        title: 'Rate your call',
        issue: 'HF-NATIVE-5',
        showBack: true,
        details: {if (callId != null) 'call': callId!, if (token != null) 'token': token!},
      );
}
