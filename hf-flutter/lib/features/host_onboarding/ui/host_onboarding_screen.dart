import 'package:flutter/material.dart';

import '../../../core/widgets/widgets.dart';

/// `/host/onboarding?step=` (needs sign-in). Built in HF-NATIVE-9 and HF-NATIVE-10.
/// `dl=return` means the person is back from DigiLocker: run `digilocker/complete` first (HF-NATIVE-8).
class HostOnboardingScreen extends StatelessWidget {
  const HostOnboardingScreen({super.key, this.step, this.digiLockerReturn = false});

  final String? step;
  final bool digiLockerReturn;

  @override
  Widget build(BuildContext context) => StubScreen(
        title: 'Become a host',
        issue: 'HF-NATIVE-9 and HF-NATIVE-10',
        showBack: true,
        details: {
          if (step != null) 'step': step!,
          if (digiLockerReturn) 'dl': 'return',
        },
      );
}
