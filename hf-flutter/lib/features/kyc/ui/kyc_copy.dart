/// Copy for the shared identity widgets (simple English, copied from the website's host steps). Kept in one
/// place so translation can come later. The brand name is never typed here.
abstract final class KycCopy {
  // Aadhaar, OTP
  static const String otpTitle = 'Verify your Aadhaar with an OTP';
  static const String otpLead = 'We send a 6-digit OTP to the mobile number linked with your Aadhaar.';
  static const String aadhaarNumberLabel = 'Aadhaar number';
  static const String otpConsent =
      'I agree to verify my Aadhaar with an OTP. My Aadhaar number is used only to send the OTP and is not stored. '
      'UIDAI shares my name, date of birth, gender, address and photo with us. Only the last 4 digits of my Aadhaar '
      'number are kept. This is used only to confirm that I am 18 or older and who I am.';
  static const String sendCode = 'Send OTP';
  static const String noPhoneLinked = 'No phone linked to your Aadhaar, or the OTP is not coming?';
  static const String useDigiLockerInstead = 'Verify with DigiLocker instead';

  static const String codeTitle = 'Enter the OTP';
  static const String codeLead = 'We sent a 6-digit OTP to the mobile linked with your Aadhaar.';
  static const String codeLabel = '6-digit OTP';
  static const String verify = 'Verify';
  static const String resend = 'Send the OTP again';
  static const String resendIn = 'Send the OTP again in';
  static const String changeNumber = 'Change Aadhaar number';
  static const String oneTryLeft = '1 try left.';
  static const String triesLeft = 'tries left.';

  // DigiLocker
  static const String tryDigiLockerTitle = "Let's try DigiLocker instead";
  static const String digiLockerTitle = 'Verify your Aadhaar with DigiLocker';
  static const String digiLockerLead =
      "You'll sign in to DigiLocker (a Government of India service), approve sharing your Aadhaar, and come straight back here.";
  static const String digiLockerConsent =
      'I agree that DigiLocker can share my Aadhaar details with us: my name, date of birth, gender, address and photo. '
      'Only the last 4 digits of my Aadhaar number are kept. This is used only to confirm that I am 18 or older and who I am.';
  static const String verifyWithDigiLocker = 'Verify with DigiLocker';
  static const String backToOtp = 'Back to Aadhaar OTP';
  static const String digiLockerNotOpened = 'We could not open DigiLocker right now. Please try again.';
  static const String waitingTitle = 'Finish in DigiLocker, then come back';
  static const String waitingLead =
      'When you are done in DigiLocker, return to this app. We check by ourselves. You can also tap Check again.';
  static const String digiLockerStillWaiting = 'DigiLocker is still sending your details. Tap Check again in a few seconds.';
  static const String checkingDigiLocker = 'Checking with DigiLocker…';
  static const String checkAgain = 'Check again';
  static const String startAgain = 'Start again';
  static const String couldNotFinish = 'We could not finish yet';
  static const String tryDigiLockerAgain = 'Try DigiLocker again';

  // Done
  static const String aadhaarVerified = 'Aadhaar verified';
  static const String aadhaarEnding = 'Aadhaar ending';

  // Selfie video
  static const String selfieTitle = '10-second selfie video';
  static const String selfieLead = 'This shows us you are a real person.';
  static const String yourCode = 'Your code';
  static const String gettingCode = 'Getting your code…';
  static const String selfieConsent =
      'I agree to record a short selfie video to prove I am a real person. Only our verification team sees it.';
  static const String openCamera = 'Open camera';
  static const String startRecording = 'Start recording';
  static const String cancel = 'Cancel';
  static const String recordingLeft = 's left';
  static const String videoReady = 'Your video is ready';
  static const String useThisVideo = 'Use this video';
  static const String recordAgain = 'Record again';
  static const String uploading = 'Sending your video…';
  static const String videoSent = 'Video sent';
  static const String videoSentBody = 'Our verification team will check it.';
  static const String cameraTitle = 'Camera and microphone';
  static const String cameraWhy = "We need your camera for a 10-second video to prove it's really you.";
  static const String cameraWhyMic = 'It also records your voice saying the code.';
  static const String cameraOff = 'The camera or microphone is turned off for this app.';
  static const String cameraOffHelp = 'Open settings, tap Permissions, turn on Camera and Microphone, then come back.';
  static const String cameraFailed = 'We could not start your camera. Please close other apps that use it and try again.';
  static const String noCamera = 'We could not find a camera on this phone.';
  static const String tooLargeLocal = 'That video is too large. Keep it to about 10 seconds.';
  static const String tooSmallLocal = 'That video looks empty. Record again.';
  static const String codeExpired = 'That code has expired. We got you a new one. Please record again.';

  // Microphone (used by voice steps too)
  static const String micTitle = 'Microphone';
  static const String micWhy = 'We need your microphone to record your voice introduction.';
}
