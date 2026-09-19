export const globalCreatorIdeas = [
  { slug: 'creator-watch-party', platform: 'YouTube', title: 'Creator watch party', description: 'React, teach, and hang out live with your biggest viewers.', color: 'coral', eyebrow: 'GO LIVE' },
  { slug: 'trend-breakdown-live', platform: 'TikTok', title: 'Trend breakdown live', description: 'Show your process, your taste, and what happens behind the trend.', color: 'yellow', eyebrow: 'GO LIVE' },
  { slug: 'close-friends-studio', platform: 'Instagram', title: 'Close friends studio', description: 'Give your inner circle a private room and your undivided time.', color: 'teal', eyebrow: 'GO 1:1' },
  { slug: 'channel-coaching', platform: 'YouTube', title: 'Channel coaching', description: 'Help newer creators find their voice, format, and next upload.', color: 'blue', eyebrow: 'GO 1:1' },
  { slug: 'learn-the-move', platform: 'TikTok', title: 'Learn the move', description: 'Teach choreography, makeup, recipes, workouts, or whatever you do best.', color: 'lime', eyebrow: 'GO LIVE' },
  { slug: 'ask-me-anything-1-1', platform: 'Instagram', title: 'Ask me anything 1:1', description: 'Make the conversation personal with bookable video time.', color: 'pink', eyebrow: 'GO 1:1' },
  { slug: 'launch-night-live', platform: 'YouTube + TikTok', title: 'Launch-night live', description: 'Bring fans together for a premiere, drop, or special announcement.', color: 'orange', eyebrow: 'GO LIVE' },
  { slug: 'taste-of-your-world', platform: 'Instagram + YouTube', title: 'Taste of your world', description: 'Share your culture, craft, language, or everyday expertise.', color: 'lavender', eyebrow: 'GO 1:1' },
] as const;

export type GlobalCreatorIdeaSlug = typeof globalCreatorIdeas[number]['slug'];

type CreatorGuide = {
  imageAlt: string;
  promise: string;
  audience: string;
  duration: string;
  introduction: string;
  preparation: string[];
  agenda: { time: string; title: string; detail: string }[];
  invitation: string;
  boundaries: string[];
  followUp: string;
};

/** Editorial examples, not promises of platform features or earnings. */
export const globalCreatorGuides: Record<GlobalCreatorIdeaSlug, CreatorGuide> = {
  'creator-watch-party': {
    imageAlt: 'Retro-styled creator with sunglasses and popcorn on coral paper',
    promise: 'Give your viewers the director’s commentary they cannot get from a comment section.',
    audience: 'Video essayists, reviewers and creators with an original video to unpack.',
    duration: '45-minute live session',
    introduction: 'Your next upload can start a conversation instead of ending one. Build a watch party around your own video: pause at the interesting choices, explain what did not make the edit and let viewers ask why. The value is your perspective and time together—not simply access to a video they can already watch.',
    preparation: [
      'Choose one video you own or have permission to screen. Mark three moments with a useful story behind them.',
      'Publish the running time, viewing instructions and time zone. Tell guests whether they will watch your screen or open the original alongside you.',
      'Collect a few questions beforehand. Test playback and microphone sound; keep a short recap ready if playback fails.',
    ],
    agenda: [
      { time: '00–05', title: 'Set the scene', detail: 'Welcome viewers, explain the discussion rules and ask what they noticed in the original.' },
      { time: '05–25', title: 'Watch with intention', detail: 'Pause at your three chosen moments. Show a draft or explain a creative trade-off rather than narrating every frame.' },
      { time: '25–40', title: 'Make room for the room', detail: 'Answer submitted questions, then take live questions without promising everybody an individual turn.' },
      { time: '40–45', title: 'Leave them with something', detail: 'Recap a surprising lesson and ask which original project they want to explore next.' },
    ],
    invitation: 'Watch my latest film with me: 45 minutes of behind-the-scenes stories, three scenes unpacked and audience Q&A. This is a live discussion, not a private coaching session.',
    boundaries: ['A ticket does not give you permission to rebroadcast films, sports, music or other creators’ work. Use material you control or have cleared.', 'Explain any recording beforehand and obtain the necessary consent. Do not publish attendee names, faces or questions without permission.'],
    followUp: 'Share a short written recap if you promised one. Ask which segment was most valuable; use that answer to choose the next watch party, not an assumed demand for a recurring subscription.',
  },
  'trend-breakdown-live': {
    imageAlt: 'Expressive creator in a patterned blue sweater on yellow paper',
    promise: 'Teach the decisions behind a trend, not a promise to go viral.',
    audience: 'Short-form creators who can explain hooks, editing, styling or visual storytelling.',
    duration: '40-minute live workshop',
    introduction: 'People see the finished fifteen seconds. They rarely see the rejected hooks, camera placement or edit that made it work. Turn that hidden process into a focused workshop. Pick one technique that participants can try with the equipment they already have.',
    preparation: ['Choose one of your own posts and one transferable technique, such as a visual hook or a match cut.', 'Prepare an original rough version and finished version so the difference is easy to see. Avoid relying on a platform’s music licence outside that platform.', 'Tell attendees what they need: a phone, a simple object and a place to make notes. Accept example questions without requiring private account access.'],
    agenda: [
      { time: '00–05', title: 'Name the technique', detail: 'Show your original result and explain the creative problem it solves.' },
      { time: '05–18', title: 'Pull it apart', detail: 'Compare the draft and final version. Explain the opening, framing and cut with concrete examples.' },
      { time: '18–30', title: 'Try a fresh version', detail: 'Build a new example live and invite viewers to sketch their own version. Participation is optional.' },
      { time: '30–40', title: 'Troubleshoot together', detail: 'Discuss common mistakes and how to adapt the technique to a different niche or audience.' },
    ],
    invitation: 'Behind the trend: learn how I build a match-cut video, from rough idea to final edit. Bring your phone and leave with a shot plan. No follower count or specialist gear needed.',
    boundaries: ['Do not guarantee reach, followers, income or algorithmic results. Teach a repeatable skill and describe outcomes honestly.', 'Credit inspiration and get permission before featuring attendees’ work. Do not encourage copying a creator’s identity or unsafe viral challenges.'],
    followUp: 'Offer the short shot checklist you advertised. Invite participants to share a result voluntarily; obtain separate permission before using their work as a testimonial or promotional example.',
  },
  'close-friends-studio': {
    imageAlt: 'Creator in pink sunglasses and a fluffy pink jacket on teal paper',
    promise: 'Turn behind-the-scenes curiosity into a focused, personal studio visit.',
    audience: 'Artists, stylists, makers and visual creators with a process worth sharing.',
    duration: '30-minute private 1:1',
    introduction: 'Your studio has stories a polished feed cannot tell. Invite one fan into a live video conversation about a specific part of your work: how you style a look, arrange a workspace or develop an illustration. Keep it warm and personal while clearly defining the professional experience they are booking.',
    preparation: ['Choose a studio theme and specify what is included. A process tour is different from a custom design commission.', 'Ask the guest for one area of interest in advance. Do not request their address, private photographs or unnecessary personal information.', 'Prepare two or three objects or works in progress. Frame your camera so private documents, addresses and other people stay out of view.'],
    agenda: [
      { time: '00–05', title: 'Meet and choose a focus', detail: 'Confirm the guest’s question and the boundaries of the visit.' },
      { time: '05–18', title: 'Open the process', detail: 'Walk through one real creative decision with the materials in front of you.' },
      { time: '18–25', title: 'Follow their curiosity', detail: 'Answer questions about your practice. Keep requests for additional work separate from the booked session.' },
      { time: '25–30', title: 'Wrap with one useful idea', detail: 'Summarise a technique or source of inspiration the guest can take away.' },
    ],
    invitation: 'A 30-minute private look inside my styling process. Pick one topic—colour, layering or building a moodboard—and we will explore it together. Custom designs and ongoing messaging are not included.',
    boundaries: ['“Close friends” describes the intimate format, not a friendship, romantic relationship or an Instagram product integration.', 'Agree on recording and screenshots before starting. Keep personal contact details and your physical studio location private.'],
    followUp: 'Send only the resources you agreed to provide. Keep future contact within appropriate booking channels and make any next session a clear, optional purchase.',
  },
  'channel-coaching': {
    imageAlt: 'Smiling creator with a laptop and black beanie on blue paper',
    promise: 'Help a newer creator make one better next video.',
    audience: 'Experienced video creators who can give constructive, specific feedback.',
    duration: '45-minute private 1:1',
    introduction: 'A vague channel review can overwhelm a beginner. A focused coaching session can turn one stuck idea into a practical next step. Ask the creator to bring a single video or concept and one question. Your product is an informed second perspective—not guaranteed channel growth.',
    preparation: ['Ask for one public video link, their intended audience and their main question. Never ask for a password or channel access.', 'Review the material you have agreed to review. Note one strength and two changes with examples.', 'State whether advance review and written notes are included in the booking, and limit the amount of material you will assess.'],
    agenda: [
      { time: '00–08', title: 'Understand the creator', detail: 'Clarify their audience, constraints and the outcome they want from their next upload.' },
      { time: '08–23', title: 'Review one real example', detail: 'Discuss the opening, structure and title promise. Explain why each suggestion serves their audience.' },
      { time: '23–37', title: 'Build the next version', detail: 'Work together on a revised outline or three opening ideas that still sound like them.' },
      { time: '37–45', title: 'Choose the next action', detail: 'Agree on two manageable experiments and a way for the creator to evaluate what they learn.' },
    ],
    invitation: 'Bring one video and one sticking point. In this 45-minute channel coaching call, we will review your opening and structure, then map a clearer next upload. This is creative feedback, not a growth guarantee.',
    boundaries: ['Do not promise monetisation approval, sponsorships, views or income. Your experience does not make you a representative of YouTube.', 'Treat unpublished concepts and analytics as confidential. Get permission before using a before-and-after example publicly.'],
    followUp: 'If included, send a concise action plan with the two agreed experiments. Avoid turning the recap into a new list of paid requirements; let the creator decide whether another review would help.',
  },
  'learn-the-move': {
    imageAlt: 'Dance creator striking a pose on bright lime paper',
    promise: 'Break a signature move into a lesson people can follow at their own pace.',
    audience: 'Dance and movement creators who can teach a beginner-friendly sequence safely.',
    duration: '35-minute live class',
    introduction: 'A performance makes a move look effortless. A useful class shows the slower steps, the counts and an easier variation. Teach a short original sequence with a clear ability level. The goal is an enjoyable learning experience—not matching your performance or pushing through discomfort.',
    preparation: ['Describe the level, space and footwear needed. Choose low-impact variations and invite attendees to observe instead of participating.', 'Use a full-body camera frame, good light and clear spoken counts. Check that your movements remain visible when you step sideways.', 'Use original or appropriately licensed music. Prepare to teach with counts alone if music cannot be used.'],
    agenda: [
      { time: '00–05', title: 'Set up the space', detail: 'Explain the class, ask participants to check their surroundings and demonstrate the gentler option.' },
      { time: '05–15', title: 'Teach the first half', detail: 'Break the sequence into small pieces and repeat slowly with consistent counts.' },
      { time: '15–25', title: 'Connect the sequence', detail: 'Add the remaining steps, showing both the standard and lower-impact versions.' },
      { time: '25–35', title: 'Practise and reflect', detail: 'Run the sequence slowly, answer technique questions and remind everyone they can stop at any point.' },
    ],
    invitation: 'Learn an original eight-count routine in a relaxed 35-minute live class. Beginner-friendly, with a low-impact option. You will need a clear space; watching and taking notes is welcome too.',
    boundaries: ['Stay within your qualifications. Do not diagnose injuries, prescribe rehabilitation or promise fitness results; participants should stop if movement causes pain.', 'Get permission to teach choreography you did not create and to use any music. Never require guests to appear on camera or publish a performance.'],
    followUp: 'Provide a written count breakdown if it was included. Ask which transition needed more explanation so the next class can improve without collecting unnecessary health details.',
  },
  'ask-me-anything-1-1': {
    imageAlt: 'Friendly creator in a purple knit sweater on pink paper',
    promise: 'Give one fan a thoughtful conversation with clear boundaries.',
    audience: 'Creators whose audience has questions about their craft, journey or creative choices.',
    duration: '20-minute private 1:1',
    introduction: 'An AMA works best when “anything” has a useful frame. Invite questions about your public work, creative routine or a shared interest. A short private session can feel genuinely personal without promising friendship, access to your private life or specialist advice you are not qualified to give.',
    preparation: ['List the topics you welcome and those you will not discuss. Explain the session length and whether any follow-up is included.', 'Ask the guest to submit two or three questions. Use them to prepare, not to collect sensitive information.', 'Choose a neutral setting, test your connection and decide how you will politely redirect requests that cross a boundary.'],
    agenda: [
      { time: '00–03', title: 'Get comfortable', detail: 'Introduce the format, confirm the guest’s priority and explain that either person can decline a question.' },
      { time: '03–15', title: 'Have the conversation', detail: 'Start with the submitted questions. Share specific stories and leave room for a natural follow-up.' },
      { time: '15–18', title: 'One final question', detail: 'Give a gentle time reminder and ask which remaining question matters most.' },
      { time: '18–20', title: 'Close warmly', detail: 'Thank the guest and recap any resource you explicitly agreed to send.' },
    ],
    invitation: 'Twenty minutes, just us: ask about my creative journey, content process or favourite projects. Bring up to three questions. Personal contact details, professional advice and ongoing access are not included.',
    boundaries: ['Do not present a fan conversation as therapy, medical, financial or legal advice. Redirect questions outside your expertise.', 'No recording, screenshots or sharing of private discussion without the required consent. Follow platform safety rules and age requirements.'],
    followUp: 'Deliver only the promised follow-up. Respect a guest’s privacy even if a conversation was memorable; a paid booking is not consent to share their story in your content.',
  },
  'launch-night-live': {
    imageAlt: 'Creator with a megaphone and white sunglasses on orange paper',
    promise: 'Make your next original release an event fans can share with you.',
    audience: 'Creators launching an original film, collection, artwork or creative project.',
    duration: '50-minute live event',
    introduction: 'A launch can be more than a countdown and a sales pitch. Build an event around the story of making something: a first look, a live demonstration and time for questions. Make the ticketed experience valuable in its own right, even for a fan who never buys the product.',
    preparation: ['Define what the event ticket includes and what is sold separately. State clearly if an item, download or replay is not included.', 'Prepare an original reveal and a backup still-image walkthrough. Rehearse your transitions and keep private launch documents out of frame.', 'Set a precise date and time zone, explain the cancellation terms and plan how questions will be moderated. Avoid artificial scarcity claims.'],
    agenda: [
      { time: '00–05', title: 'Welcome the early crowd', detail: 'Explain the running order, participation rules and what the ticket covers.' },
      { time: '05–20', title: 'Make the reveal', detail: 'Show the work and tell the story behind a few defining choices.' },
      { time: '20–35', title: 'Show how it came together', detail: 'Demonstrate a detail, compare prototypes or bring the audience inside your creative process.' },
      { time: '35–50', title: 'Celebrate and answer questions', detail: 'Take questions, thank collaborators and close with accurate information about where the work is available.' },
    ],
    invitation: 'Join the live reveal of my new collection: a first look, the stories behind three designs and audience Q&A. Your ticket covers the 50-minute event; products are sold separately.',
    boundaries: ['Clear collaborator, music and footage rights before showing material. Disclose sponsorships or paid partnerships clearly.', 'Do not promise stock, delivery dates, access to other products or recordings unless you can deliver them and have stated the terms.'],
    followUp: 'Send the promised event recap or public release link. Keep attendance feedback separate from marketing consent, and do not add guests to an external mailing list without permission.',
  },
  'taste-of-your-world': {
    imageAlt: 'Creator with a colourful headwrap and camera on lavender paper',
    promise: 'Share one small, real part of your world through a personal exchange.',
    audience: 'Food, language, travel and craft creators who enjoy explaining their own lived experience.',
    duration: '30-minute private 1:1',
    introduction: 'The everyday detail you take for granted may be exactly what someone else is curious about. Offer a focused exchange: the story of a family recipe, a beginner language conversation or a demonstration of your own craft. Speak from your experience rather than presenting one perspective as an entire culture.',
    preparation: ['Choose one clearly named topic. A recipe conversation, language practice and a craft lesson require different expectations and materials.', 'Ask what the guest hopes to learn and which language you will use. Share an optional ingredient or materials list in advance if needed.', 'Prepare a small object, photograph or demonstration you have permission to share. Keep your home location and other people’s private stories off camera.'],
    agenda: [
      { time: '00–05', title: 'Start with curiosity', detail: 'Ask what drew the guest to the topic and confirm the scope of the exchange.' },
      { time: '05–18', title: 'Share a specific story or skill', detail: 'Explain one recipe tradition, practise a short conversation or demonstrate one craft technique.' },
      { time: '18–25', title: 'Explore together', detail: 'Invite questions and make room for the guest’s perspective without assumptions about their background.' },
      { time: '25–30', title: 'Take one thing home', detail: 'Recap a phrase, technique or story and explain any resource you agreed to share.' },
    ],
    invitation: 'A 30-minute conversation about the food stories I grew up with, including a walkthrough of one family recipe. No cooking experience needed. This is a personal cultural exchange, not a nutrition consultation.',
    boundaries: ['Describe your own experience without claiming to represent every person in a country or community. Credit cultural sources and collaborators.', 'For food or craft demonstrations, explain relevant practical precautions and material limitations. Do not provide health advice or promise allergen safety.'],
    followUp: 'Share the agreed recipe notes, phrase list or craft references with proper attribution. Ask which part sparked their curiosity and use that feedback to shape a specific next offering.',
  },
};
