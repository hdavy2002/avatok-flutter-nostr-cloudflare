/// Copy for onboarding part B (simple English, copied from the website's host steps). One place, so translation can
/// come later. The brand name is never typed here.
abstract final class PartBCopy {
  static const String continueLabel = 'Continue';
  static const String saving = 'Saving…';
  static const String edit = 'Edit';
  static const String saveProblemFallback = 'We could not save that. Check your internet and try again.';
  static const String sentForReviewBanner = 'Sent for review';

  // Avatar
  static const String avatarTitle = 'Choose your avatar';
  static const String avatarLead =
      'This picture represents you. Your real face is never shown. Callers see this AI avatar.';
  static const String filterGender = 'Gender';
  static const String filterAge = 'Age';
  static const String filterLook = 'Look';
  static const String all = 'All';
  static const String women = 'Women';
  static const String men = 'Men';
  static const String traditional = 'Traditional';
  static const String casual = 'Casual';
  static const String office = 'Office';
  static const String avatarNone = 'No avatars match these filters.';
  static const String avatarShowAll = 'Show all avatars';
  static const String avatarNote = 'Once you pick an avatar it becomes yours only.';
  static const String avatarTaken = 'Taken';
  static const String avatarAiLabel = 'AI avatar';
  static const String avatarChosen = 'Your avatar is chosen';
  static const String avatarClaimFailed = 'We could not choose that avatar. Please try another.';
  static const String avatarsLoading = 'Loading avatars…';

  // About
  static const String aboutTitle = 'About you';
  static const String aboutLead = 'Callers pick a host by reading this. Keep it warm and simple.';
  static const String nameLabel = 'First name';
  static const String nameHint = 'For example, Neha';
  static const String nameHelp = 'Only your first name is shown. You can use a nickname.';
  static const String nameFormat = 'Use 2 to 20 letters. No numbers or symbols.';
  static const String aboutLabel = 'Tell callers about yourself';
  static const String aboutHint =
      'I am a good listener. I like old songs and evening chai. If you had a hard day, I am happy to talk.';
  static const String aboutHelp =
      'We will polish your words into your profile. Never add phone numbers, links or social media.';
  static const String ideasTitle = 'Tap to add an idea';
  static const List<String> ideas = <String>[
    'I love listening to people and I never judge.',
    'I like old songs, cooking and a good cup of chai.',
    'I have lived in a big city and a small town, so I understand both.',
  ];
  static String aboutMore(int n) => 'Write at least $n more characters.';

  // Languages and style
  static const String languagesTitle = 'Languages and style';
  static const String languagesLead = 'Callers want to talk in a language they feel at home in.';
  static const String languagesLegend = 'Languages you speak (pick at least one)';
  static const String languagesMax = 'You can pick up to 6 languages.';
  static const String styleLegend = 'Your conversation style';

  // Topics
  static const String topicsTitle = 'What do you like to talk about?';
  static const String topicsLead = 'Callers search by these. Pick only topics you are comfortable with.';
  static String topicsCount(int n) => '$n of 6 chosen';
  static const String topicsFull = ' That is the most. Remove one to pick another.';
  static const String topicsMore = 'More';

  // Price
  static const String priceTitle = 'Your price';
  static const String priceLead = 'One price for every topic, charged per minute of call.';
  static const String perMin = '/ min';
  static const String quickPicks = 'Quick picks';
  static const String callerPays = 'Caller pays';
  static const String youGet = 'You get';
  static const String platformGets = 'Platform (includes GST)';
  static const String priceChangeAnytime = 'You can change your price any time.';
  static String priceExample(String amount) => '1 hour of calls a day for 25 days is about $amount for you';
  static const String lowerPrice = 'Lower price by 1 rupee';
  static const String raisePrice = 'Raise price by 1 rupee';
  static const String priceSlider = 'Price per minute in rupees';

  // Hours and comfort
  static const String hoursTitle = 'When are you usually free?';
  static const String hoursLead =
      'This is optional. It only helps callers know when to find you. You can still go online any time.';
  static const String daysLegend = 'Days';
  static const String fromLabel = 'From';
  static const String toLabel = 'To';
  static const String comfortTitle = 'Your comfort';
  static const String comfortLockedLive = 'The comfort switches are locked while you are live. Days and times can still change.';
  static const String healthConsent =
      "I am comfortable talking about health topics (for example women's health) when a caller asks";
  static const String lgbtqTitle = 'Join the LGBTQ+ space';
  static const String lgbtqBody =
      'A private lane where LGBTQ+ callers talk to LGBTQ+ hosts. Only verified callers can reach you there. '
      'This choice is private. We never guess, and you can change it any time.';
  static const String lgbtqPublic = "Also show 'LGBTQ+ friendly' on my public profile (optional)";
  static const String womenLane = 'Also join the women-only lane. Only verified women can call you there.';

  // Voice
  static const String voiceTitle = 'Record your introduction';
  static const String voiceLead =
      'Say hello in your own voice. About a minute is perfect (at least 30 seconds, at most 5 minutes). '
      'Callers can hear it on your card and your profile, labelled "Recorded by the host".';
  static const String voiceIdeasTitle = 'What can I say?';
  static const String voiceTips = 'Tips';
  static const String voiceDontsTitle = 'Please do not say';
  static const String voiceDonts =
      'a phone number, WhatsApp, Instagram or any other social handle, an email, your workplace, your area or your '
      'address. We check every recording.';
  static const List<String> voiceTipItems = <String>[
    'Say your first name only',
    'Say the languages you speak',
    'Say what you enjoy talking about',
    'Say what kind of listener you are',
    'Say when you are usually free',
  ];
  static const String voiceTapMic = 'Tap the microphone to start';
  static const String voiceRecording = 'Recording…';
  static const String voiceKeepGoing = 'Keep going. At least 30 seconds, please.';
  static const String voiceNiceStop = 'Nice. You can stop any time now, or keep talking.';
  static const String voiceCanStop = 'You can stop now.';
  static const String voiceAutoStop = 'It stops by itself at 5:00.';
  static const String voiceStop = 'Stop';
  static const String voiceStartOver = 'Start over';
  static const String voiceListenFirst = 'Listen to it first';
  static const String voiceSave = 'Save my introduction';
  static const String voiceUploading = 'Sending your recording…';
  static const String voiceRecordAgain = 'Record again';
  static const String voiceKeepSaved = 'Keep my saved introduction';
  static const String voiceNeedConsent = 'Tick the box below to save it.';
  static const String voiceConsent = 'This is my own voice. I agree it will be played on my public profile.';
  static const String voiceSavedTitle = 'Your introduction is saved';
  static const String voiceStatusPending = 'Saved. Our team will listen before it goes live.';
  static const String voiceStatusApproved = 'Approved. It is live on your profile.';
  static const String voiceStatusRejected =
      'We could not use this one. Please record it again, and leave out phone numbers and social handles.';
  static const String voiceChecked = 'We check every recording for phone numbers, social handles and addresses.';
  static const String voiceMicFailed = 'We could not start the microphone. Close other apps that record sound and try again.';
  static const String voiceRecorded = 'Recorded by you';
  static const String voicePlay = 'Play';
  static const String voicePause = 'Pause';
  static const String voicePlayFailed = 'We could not play that. Please try again.';
  static const String voiceLoading = 'Getting your recording…';
  static String voiceTooShort(int s) => 'That is only $s seconds. Please record at least 30 seconds.';
  static const String voiceTooLong = 'That is longer than 5 minutes. Please keep it under 5 minutes.';
  static String voiceLength(String clock) => 'Length $clock';
  static const String hindi = 'हिंदी';
  static const String english = 'English';

  // Review
  static const String reviewTitle = 'Check everything';
  static const String reviewLead = 'Have a last look. You can change anything before we make your profile.';
  static const String reviewVerified = 'Verified';
  static const String reviewAvatar = 'Avatar';
  static const String reviewNameAbout = 'Name and about';
  static const String reviewLanguages = 'Languages and style';
  static const String reviewTopics = 'Topics';
  static const String reviewPrice = 'Price';
  static const String reviewHours = 'Hours and comfort';
  static const String reviewVoice = 'Voice introduction';
  static const String reviewNoAvatar = 'No avatar chosen yet.';
  static const String reviewNoVoice = 'Not recorded yet';
  static const String reviewNoDays = 'No days chosen';
  static const String reviewAllCallers = 'All callers';
  static const String reviewWomenOnly = 'Women lane: on';
  static const String reviewLgbtqOn = 'LGBTQ+ space: yes (private)';
  static const String reviewLgbtqPublic = 'LGBTQ+ space: yes (shown on profile)';
  static const String reviewLgbtqOff = 'LGBTQ+ space: no';
  static const String agreeRules = 'I have read the host rules.';
  static const String agreeAgreement = 'I accept the host agreement.';
  static const String agreeWelfare = 'I have read the welfare and crisis guide.';
  static const String readRules = 'Read the host rules';
  static const String readAgreement = 'Read the host agreement';
  static const String readWelfare = 'Read the welfare guide';
  static const String createProfile = 'Create my profile';
  static const String seeProgress = 'See progress';

  // Generating
  static const String generatingTitle = 'Creating your profile';
  static const String generatingLead =
      'This usually takes a few minutes. You can close the app. We will tell you on WhatsApp when it is ready.';
  static const String stageText = 'Writing your profile';
  static const String stageImages = 'Creating your avatar photos';
  static const String stageSafety = 'Safety check';
  static const String stageWaiting = 'waiting';
  static const String stageWorking = 'working';
  static const String stageDone = 'done';
  static const String stageSkipped = 'skipped for now';
  static const String stageFailed = 'failed';
  static const String generatingStarting = 'Starting…';
  static const String generatingOffline = 'We lost the connection. Trying again…';
  static const String generatingSlow =
      'This is taking longer than expected. You can close the app. We will message you on WhatsApp when it is ready.';
  static const String generatingFailed = 'Something went wrong while making your profile. Please try again.';
  static const String generatingNotReady = 'Your profile is not ready yet. Please try again in a moment.';
  static const String generatingExhausted =
      'You have used all 3 tries to make your profile. Please contact support and we will help.';
  static const String generatingMissing = 'A few steps are still missing.';
  static const String tryAgain = 'Try again';
  static const String generatingReadyTitle = 'Your profile is ready';
  static const String generatingReadyBody = 'You can look at it, change it, or make a new version.';
  static const String seeMyProfile = 'See my profile';
  static const String makeNewVersion = 'Make a new version';
  static const String changeSomething = 'Change something';
  static String triesLeft(int n) => n == 1 ? '1 try left.' : '$n tries left.';
  static const String fixThis = 'Fix this step';

  // Preview
  static const String previewTitle = 'This is how callers will see you';
  static const String previewLead = 'Have a look. You can change the tagline, the quote and the about text.';
  static const String previewCard = 'Your card';
  static const String previewPage = 'Your profile page';
  static const String previewAbout = 'About';
  static const String previewEditTagline = 'Edit tagline';
  static const String previewEditQuote = 'Edit quote';
  static const String previewEditAbout = 'Edit about';
  static const String taglineLabel = 'Tagline';
  static const String quoteLabel = 'Quote';
  static const String aboutEditLabel = 'About';
  static const String save = 'Save';
  static const String cancel = 'Cancel';
  static const String previewVoice = 'Your voice introduction';
  static const String previewNoVoice = 'You have not recorded your introduction yet.';
  static const String previewRecordNow = 'Record it now';
  static const String previewGallery = 'Avatar gallery';
  static const String previewPrivacy =
      "To protect our hosts' privacy, the photos on host profiles are AI-generated from an avatar the host chose. "
      "The voice introduction is the host's own recording. The person callers talk to is the real, verified host.";
  static const String sendForReview = 'Looks good. Send for review';
  static const String previewChangesTitle = 'Changes needed';
  static const String previewChangesFallback = 'Our team asked for a few changes. Fix them and send it again.';
  static const String previewLockedPending = 'Your profile is with our team. We will tell you on WhatsApp.';
  static const String previewLockedLive = 'Your profile is live.';
  static const String previewPerMin = '/min';

  // Done
  static const String doneTitle = 'Sent for review!';
  static const String doneLead =
      "Our team checks every new profile, usually within 24 hours. We'll message you on WhatsApp when you're live.";
  static const String liveTitle = 'You are live!';
  static const String liveLead = 'Callers can find you now. Go online from your dashboard whenever you like.';
  static const String nextTitle = 'What happens next';
  static const String nextOnline = 'Go online from your dashboard whenever you like.';
  static const String nextCalls = 'Calls ring your phone. Your number stays private.';
  static const String nextDecline = 'You can decline any call.';
  static const String goDashboard = 'Go to my host dashboard';
  static const String goHome = 'Back to Home';
}
