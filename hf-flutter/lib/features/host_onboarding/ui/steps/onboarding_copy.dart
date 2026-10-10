/// Copy for onboarding steps A (simple English; the Hindi line is the website's own).
abstract final class OnboardingCopy {
  static const String screenTitle = 'Become a host';
  static const String stepOf = 'Step';
  static const String of = 'of';

  // Welcome
  static const String welcomeTitle = 'Earn from home by talking to people';
  static const String welcomeLead =
      'Listen, chat and be a friendly voice for people who want to talk. You pick your price and your hours.';
  static const String welcomeHinglish = 'Ghar baithe kamaayein, bas baat karke.';
  static const String needTitle = 'What you need';
  static const String needPhone = 'Your own phone with WhatsApp';
  static const String needAadhaar = 'Your Aadhaar card';
  static const String needBank = 'Your bank account, in your own name';
  static const String needTime = 'About 10 minutes of your time';
  static const String needQuiet = 'A quiet place to record a short voice introduction';
  static const String keepTitle = 'What we keep';
  static const String keepBody =
      'We keep only the last 4 digits of your Aadhaar number. Your Aadhaar details, photo and selfie video are stored '
      'encrypted and seen only by our verification team. Your face and real photos are never shown to callers. '
      'You pick an AI avatar, and callers never see your number.';
  static const String start = 'Start';
  static const String readRules = 'Read host rules';
  static const String factsAge = '18+ only';
  static const String factsPrice = 'You choose your price';
  static const String factsPhone = 'Calls come to your phone';

  // Phone
  static const String phoneTitle = 'Your WhatsApp number';
  static const String phoneVerifiedTitle = 'Your number is verified';
  static const String phoneVerifiedBody = "Calls will ring on this number. It is never shown to anyone.";
  static const String phoneNotVerifiedTitle = 'Verify your WhatsApp number';
  static const String phoneNotVerifiedBody =
      'We need to check the number your calls will ring on. It takes a minute, and we never show it to callers.';
  static const String phoneVerifyButton = 'Verify my number';
  static const String phoneCheckAgain = 'I have done it, check again';

  // Aadhaar
  static const String aadhaarDoneTitle = 'Aadhaar verified';
  static const String aadhaarAge = 'Age: 18 or older';
  static const String aadhaarKeep =
      'Your Aadhaar details and photo are stored encrypted and seen only by our verification team. '
      'We never keep your full Aadhaar number, only the last 4 digits.';

  // Selfie
  static const String selfieSentTitle = 'Video sent';
  static const String selfieSentBody = 'Our verification team will check it. You can go on while we do.';
  static const String selfieRejectedTitle = 'Your last video was not accepted';
  static const String selfieRejectedFallback = 'Please record a new video.';
  static const String selfieRecordAgain = 'Record again';

  // Payout
  static const String payoutTitle = 'Where we pay you';
  static const String payoutLead = 'We check the account is in your own name. The name must match your Aadhaar.';
  static const String upiLabel = 'UPI ID';
  static const String upiHint = 'name@bank';
  static const String accountLabel = 'Bank account number';
  static const String accountConfirmLabel = 'Confirm account number';
  static const String ifscLabel = 'IFSC code';
  static const String ifscHint = 'HDFC0001234';
  static const String upiFormat = 'Use the format name@bank';
  static const String accountFormat = 'Account numbers have 9 to 18 digits.';
  static const String accountSame = 'The two numbers are not the same.';
  static const String ifscFormat = 'IFSC has 11 characters, like HDFC0001234.';
  static const String payoutKeep = 'We keep only the last 4 digits of your account number.';
  static const String payoutVerify = 'Check my account';
  static const String payoutMismatchTitle = 'The name does not match';
  static const String payoutMismatch =
      'The name on this account does not match your Aadhaar. Please use an account in your own name.';
  static const String payoutDoneTitle = 'Payout details checked';
  static const String payoutDoneMatch = 'Name matches your Aadhaar';
  static const String payoutChange = 'Change payout details';
  static const String nameAtBank = 'Name at bank';
  static const String accountEnding = 'Bank account ending';

  static const String continueLabel = 'Continue';
  static const String loadingState = 'Getting your details…';
  static const String notBuiltTitle = 'This step is coming';
  static const String notBuiltBody = 'We are still building this part of the app. Please check back soon.';
}
