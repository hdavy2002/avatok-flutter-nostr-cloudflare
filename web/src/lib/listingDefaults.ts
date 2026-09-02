/* [LIST-WIZ-1] Per-category starter content for the 8-step listing wizard.
 *
 * Spec: Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md §F (step 5 "How it
 * works" and step 6 "House rules" are both PRE-FILLED per category) and
 * Specs/SPEC-2026-09-02-LISTING-TRUST-AND-VIBE.md §5 (voice: Hinglish, slang as
 * garnish — not every sentence, not a costume).
 *
 * The real `listing_categories` table (worker/migrations/listings.sql +
 * 2026-08-31-bazaar-session-categories.sql) has exactly these ids: teachers,
 * astrologers, professors, fitness, music, cooking, business, language, art,
 * wellness, live_friends, adda_rooms, glow_up. There is no "comedy", "quiz",
 * "antakshari" or "tax"/"career" row — those are FLAVOURS of an existing
 * category (an antakshari night is filed under `music`; a tax consult is
 * filed under `business`). `flavorFor()` below is the one place that mapping
 * lives, so a creator picking a real category id still gets copy written for
 * the specific thing people actually list there.
 *
 * Every field here mirrors a server-validated shape exactly — see
 * contentAttrsError in worker/src/routes/listings.ts:
 *   howItWorks     -> attrs.content_how_it_works      2-5 {label<=24, body<=240}
 *   houseRulesIntro-> attrs.content_house_rules_intro  <=280
 *   houseRules     -> attrs.content_house_rules        3-8 {heading<=32, body<=200}
 *   whatYouGet     -> attrs.content_what_you_get       3-5 strings <=80
 *   whoFor/notFor  -> attrs.content_who_for/not_for    <=3 strings <=80
 *   faq            -> attrs.content_faq                3-6 {q<=120, a<=300}
 *   sampleQa       -> attrs.content_sample_qa (consult) <=3 {q,a}
 *   sampleChat     -> attrs.content_sample_chat (AI)    <=6 {who<=40, line<=300}
 *   canDo/cantDo   -> attrs.content_can_do/cant_do (AI) <=3 strings <=80
 *   credential     -> the `credential` column (<=40)
 *
 * A creator can edit or delete every prefilled line — this is a starting
 * point so the form is never a blank page, never the final copy.
 */

export interface HowItWorksStep { label: string; body: string }
export interface HouseRule { heading: string; body: string }
export interface Qa { q: string; a: string }

export interface ListingContentDefaults {
  howItWorks: HowItWorksStep[];
  houseRulesIntro: string;
  houseRules: HouseRule[];
  whatYouGet: string[];
  whoFor: string[];
  notFor: string[];
  faq: Qa[];
  /** consult only */
  sampleQa?: Qa[];
  /** ai_agent only */
  sampleChat?: { who: string; line: string }[];
  canDo?: string[];
  cantDo?: string[];
  credential?: string;
}

export type ListingFlavor =
  | 'music' | 'comedy' | 'quiz' | 'fitness' | 'cooking' | 'astro'
  | 'consult_tax' | 'consult_career' | 'ai_bestie' | 'generic';

/** The one place category+kind resolves to a flavour of starter copy. */
export function flavorFor(category: string, kind: string): ListingFlavor {
  if (kind === 'ai_agent') return 'ai_bestie';
  switch (category) {
    case 'music': return 'music';
    case 'art': return 'comedy';
    case 'teachers': return 'quiz';
    case 'fitness': return 'fitness';
    case 'cooking': return 'cooking';
    case 'astrologers': return 'astro';
    case 'business': return 'consult_tax';
    case 'professors': return 'consult_career';
    default: return 'generic';
  }
}

const DEFAULTS: Record<ListingFlavor, ListingContentDefaults> = {
  music: {
    howItWorks: [
      { label: 'Join', body: 'Hop into the room at start time — link lands in your inbox 10 min before.' },
      { label: 'Warm-up', body: 'We start with a quick antakshari round to get everyone’s energy up.' },
      { label: 'The main set', body: 'Song requests, sing-alongs, and a few surprises — bring your favourite gaana.' },
      { label: 'Wrap', body: 'We close with a group singalong. Replay stays up if you enable it.' },
    ],
    houseRulesIntro: 'Ek chhota sa adda — sur bigde toh koi baat nahi, bas maza aana chahiye.',
    houseRules: [
      { heading: 'Mic on for your turn', body: 'Keep yourself muted otherwise so the sound stays clean for everyone.' },
      { heading: 'No song is a wrong song', body: 'Bollywood, Sufi, indie — sab chalega. Just keep it 18+ friendly.' },
      { heading: 'Be on time', body: 'We start sharp — latecomers can join but the antakshari round won’t wait.' },
      { heading: 'Respect the stage', body: 'One singer at a time. Cheer in chat, not over the mic.' },
    ],
    whatYouGet: ['A live singing session, not a recording', 'Song requests taken live', 'A fun antakshari warm-up round', 'Replay access if enabled'],
    whoFor: ['Anyone who loves singing, even a little off-key', 'Bollywood and indie music fans', 'People who want a fun evening adda'],
    notFor: ['Silent listeners who don’t want to sing along', 'Anyone expecting a professional concert recording'],
    faq: [
      { q: 'Do I need to sing well?', a: 'Bilkul nahi — this is for fun, not a competition. Sur kaisa bhi ho, maza guaranteed.' },
      { q: 'Can I just watch?', a: 'Haan, you can keep your mic off and enjoy — but singing along is more fun.' },
      { q: 'What if I join late?', a: 'You can still join mid-session — you’ll just miss the warm-up round.' },
    ],
  },
  comedy: {
    howItWorks: [
      { label: 'Doors open', body: 'Join 5 minutes early — we start with some crowd banter before the set.' },
      { label: 'The set', body: 'A tight set of stand-up, built fresh for this room — desi observations, everyday chaos.' },
      { label: 'Crowd work', body: 'Chat stays open — the best lines usually come from your replies.' },
      { label: 'Encore', body: 'A short Q&A or an extra bit if the room’s got the energy for it.' },
    ],
    houseRulesIntro: 'Comedy show hai, roast bhi ho sakta hai — thodi thick skin le aana.',
    houseRules: [
      { heading: 'Heckling is welcome, hate isn’t', body: 'Banter in chat is part of the show. Personal attacks get you muted.' },
      { heading: 'No recording without asking', body: 'Bits are unreleased material — don’t clip and post without permission.' },
      { heading: 'Adult humour ahead', body: 'This is an 18+ friendly room. Sensitive topics may come up.' },
      { heading: 'Stay for the whole set', body: 'Leaving mid-bit throws off the room’s energy for everyone else.' },
    ],
    whatYouGet: ['A live stand-up set, not a rerun', 'Crowd-work moments built from live chat', 'A relaxed, informal room', 'Bonus Q&A if time allows'],
    whoFor: ['Anyone who wants a laugh after a long day', 'Fans of desi observational comedy', 'People who enjoy interactive shows'],
    notFor: ['Anyone easily offended by edgy jokes', 'Those wanting a squeaky-clean, family-friendly set'],
    faq: [
      { q: 'Is this appropriate for everyone?', a: 'It’s an 18+ friendly room with some adult humour — not for younger viewers.' },
      { q: 'Will you take requests from chat?', a: 'Sometimes — the best crowd lines often make it into the bit.' },
      { q: 'Is it recorded?', a: 'Only if the listing says a replay is available. Otherwise it’s live-only.' },
    ],
  },
  quiz: {
    howItWorks: [
      { label: 'Team up (or solo)', body: 'Join the room — play solo or squad up with friends in chat.' },
      { label: 'Rounds begin', body: 'Mixed rounds — general knowledge, Bollywood, sports, and a rapid-fire.' },
      { label: 'Answer live', body: 'Drop your answers in chat before the timer runs out.' },
      { label: 'Winners announced', body: 'Scores tallied live — bragging rights (and sometimes prizes) at the end.' },
    ],
    houseRulesIntro: 'Fair khel, full masti — Google karna allowed nahi hai!',
    houseRules: [
      { heading: 'No searching answers', body: 'It’s an honesty-based quiz — Googling takes the fun out of it.' },
      { heading: 'One answer per round', body: 'Submit before the timer ends; edits after the buzzer don’t count.' },
      { heading: 'Keep chat on-topic', body: 'Save the side chatter for after the round wraps.' },
      { heading: 'Respect other players', body: 'No trolling teammates or rivals during play.' },
    ],
    whatYouGet: ['A live, hosted trivia session', 'Mixed rounds across categories', 'Live scoring and a leaderboard', 'A fun, competitive hour'],
    whoFor: ['Trivia and quiz lovers', 'Friend groups who want to compete together', 'Anyone who enjoys a bit of friendly competition'],
    notFor: ['Anyone looking for a passive, watch-only session'],
    faq: [
      { q: 'Can I play with friends?', a: 'Haan, form a team in chat before we start — squads are welcome.' },
      { q: 'What if I don’t know an answer?', a: 'Skip it, no penalty — just answer the next round.' },
      { q: 'Are there prizes?', a: 'Check the listing details — some sessions run for bragging rights only.' },
    ],
  },
  fitness: {
    howItWorks: [
      { label: 'Warm-up', body: '5-10 minutes of mobility and light cardio to get the body ready.' },
      { label: 'The main workout', body: 'Follow along live — modifications called out for every fitness level.' },
      { label: 'Cool-down', body: 'Stretching and breathing to bring the heart rate back down.' },
      { label: 'Form check', body: 'Ask questions live — I’ll call out corrections as we go.' },
    ],
    houseRulesIntro: 'Apni body sunna — push karo, lekin apni limit ke andar.',
    houseRules: [
      { heading: 'Clear your space', body: 'Make sure you’ve got room to move safely before we start.' },
      { heading: 'Modify if needed', body: 'Injuries or beginner? Say so in chat — I’ll give you an easier version.' },
      { heading: 'Hydrate', body: 'Keep water nearby — we take short breaks between blocks.' },
      { heading: 'Camera optional', body: 'You don’t have to be on camera to follow along, but it helps me check your form.' },
    ],
    whatYouGet: ['A live, coached workout session', 'Modifications for every level', 'Real-time form corrections', 'A structured warm-up and cool-down'],
    whoFor: ['Beginners who want guided coaching', 'Anyone who works out better with company', 'People who want live form correction'],
    notFor: ['Anyone with an injury who hasn’t cleared exercise with a doctor', 'Those wanting a pre-recorded, self-paced video'],
    faq: [
      { q: 'What equipment do I need?', a: 'Just a mat and water — most moves use bodyweight unless the listing says otherwise.' },
      { q: 'I’m a total beginner, is that okay?', a: 'Bilkul — every move has an easier variation, just call it out in chat.' },
      { q: 'What if I have an injury?', a: 'Mention it before we start and I’ll suggest a safe modification, or sit that block out.' },
    ],
  },
  cooking: {
    howItWorks: [
      { label: 'Prep list', body: 'Ingredient list goes out before start time — prep your station in advance.' },
      { label: 'Cook along live', body: 'We cook step by step together — pause and ask questions any time.' },
      { label: 'Plate up', body: 'Final plating tips and easy swaps for what’s in your kitchen.' },
      { label: 'Taste & talk', body: 'Show off your dish in chat — I’ll answer questions as everyone finishes.' },
    ],
    houseRulesIntro: 'Kitchen thodi messy ho sakti hai — bas maza aana chahiye, perfection nahi.',
    houseRules: [
      { heading: 'Prep before we start', body: 'Chop and measure ahead so you’re not scrambling mid-recipe.' },
      { heading: 'Substitutions are fine', body: 'Don’t have an ingredient? Ask in chat — most things have a swap.' },
      { heading: 'Camera on your station is optional', body: 'Show your dish if you want feedback, or just cook along quietly.' },
      { heading: 'Kitchen safety first', body: 'Take care around the stove — don’t rush a step to keep up.' },
    ],
    whatYouGet: ['A live, guided cook-along', 'A prep list sent before the session', 'Easy ingredient swaps', 'Live Q&A while you cook'],
    whoFor: ['Home cooks wanting to learn a new dish', 'Anyone who cooks better with company', 'Beginners who want step-by-step guidance'],
    notFor: ['Anyone without basic kitchen access', 'Those wanting a professional culinary class'],
    faq: [
      { q: 'What if I don’t have an ingredient?', a: 'Ask in chat — I’ll suggest a substitute that still works.' },
      { q: 'Do I need fancy equipment?', a: 'Nahi, a basic kitchen setup is enough — the recipe is written for home cooks.' },
      { q: 'Can I join without cooking?', a: 'Haan, you can just watch and cook it later — the session stays useful either way.' },
    ],
  },
  astro: {
    howItWorks: [
      { label: 'Share your details', body: 'Send your birth date, time and place before the session so I can prep your chart.' },
      { label: 'The reading', body: 'We go through your chart live — career, relationships, health, whatever’s on your mind.' },
      { label: 'Your questions', body: 'Bring specific questions — the reading is more useful when it’s focused.' },
      { label: 'Remedies (if any)', body: 'If something needs attention, I’ll suggest simple remedies — no pressure to buy anything.' },
    ],
    houseRulesIntro: 'Khula dil se aana — sawal jo bhi ho, judgment nahi milega.',
    houseRules: [
      { heading: 'Accurate birth details matter', body: 'A wrong birth time changes the whole chart — double-check before you send it.' },
      { heading: 'This is guidance, not a guarantee', body: 'Astrology offers perspective — final decisions are always yours.' },
      { heading: 'Privacy respected', body: 'What’s discussed in your session stays between us.' },
      { heading: 'Come with questions', body: 'The more specific your question, the more useful the reading.' },
    ],
    whatYouGet: ['A personalised live reading', 'Time to ask your own questions', 'Practical, simple remedies if relevant', 'A private, judgment-free session'],
    whoFor: ['Anyone curious about their chart', 'People facing a specific decision (career, relationship, health)', 'First-timers as well as regulars'],
    notFor: ['Anyone seeking a medical or legal opinion instead of astrology', 'Those wanting a guaranteed prediction'],
    faq: [
      { q: 'What details do I need to send?', a: 'Your date, exact time and place of birth — the more accurate, the better the reading.' },
      { q: 'What if I don’t know my exact birth time?', a: 'Bata dena — we can still do a reading, just a little less precise on timing-based questions.' },
      { q: 'Is this a one-time session or ongoing?', a: 'This listing is one session — book again any time for a follow-up.' },
    ],
  },
  consult_tax: {
    howItWorks: [
      { label: 'Share your situation', body: 'Send a quick summary of your tax question before the call so I can prep.' },
      { label: 'The consultation', body: 'We go through your numbers and options live over video.' },
      { label: 'Clear next steps', body: 'You leave with a specific action plan, not just general advice.' },
      { label: 'Follow-up notes', body: 'A short written summary after the call, if you need one for your records.' },
    ],
    houseRulesIntro: 'Seedhi baat, koi jargon nahi — bas aapke numbers samajhna hai.',
    houseRules: [
      { heading: 'Share documents in advance', body: 'Send relevant statements or numbers ahead of time for a focused session.' },
      { heading: 'This is guidance, not filing', body: 'I’ll advise on strategy — actual filing is a separate service if needed.' },
      { heading: 'Confidential by default', body: 'Your financial details are never shared or discussed elsewhere.' },
      { heading: 'Come with your questions ready', body: 'A focused list of questions gets you more value from the time.' },
    ],
    whatYouGet: ['A focused 1:1 consultation', 'Practical next steps, not just theory', 'A written summary on request', 'Confidential handling of your details'],
    whoFor: ['Freelancers and small business owners', 'Anyone confused about deductions or filing', 'People planning ahead for the next tax year'],
    notFor: ['Anyone needing representation in a legal tax dispute', 'Those wanting the actual filing done for them (ask separately)'],
    faq: [
      { q: 'What should I bring to the call?', a: 'Any relevant income/expense statements — the more specific, the better the advice.' },
      { q: 'Will you file my taxes for me?', a: 'This session is advice and strategy — filing itself can be arranged separately if needed.' },
      { q: 'Is my information kept private?', a: 'Haan, completely confidential — nothing discussed here goes anywhere else.' },
    ],
    sampleQa: [
      { q: 'Can freelancers claim home office expenses?', a: 'In most cases yes, proportionally — we’ll go through what applies to your setup on the call.' },
      { q: 'What records should I be keeping?', a: 'Invoices, receipts and bank statements at minimum — I’ll give you a simple checklist.' },
    ],
    credential: 'Chartered Accountant',
  },
  consult_career: {
    howItWorks: [
      { label: 'Tell me your goal', body: 'Share what you’re working toward before the call — a switch, a promotion, a first job.' },
      { label: 'The consultation', body: 'We map out where you are, where you want to be, and what’s in the way.' },
      { label: 'An action plan', body: 'You leave with 2-3 concrete next steps, not vague encouragement.' },
      { label: 'Resume/LinkedIn notes (if relevant)', body: 'Quick feedback on your resume or profile if it’s part of your goal.' },
    ],
    houseRulesIntro: 'Honest feedback doonga — kabhi thoda kadwa lag sakta hai, but useful hoga.',
    houseRules: [
      { heading: 'Come with a specific goal', body: 'A focused question ("should I switch to product?") beats "help me with my career".' },
      { heading: 'Share your resume in advance', body: 'If relevant, send it ahead so we can spend the call on strategy, not reading.' },
      { heading: 'Honest feedback, always kind', body: 'Direct advice, delivered respectfully — not sugar-coated, not harsh.' },
      { heading: 'Confidential', body: 'What you share about your job or company stays between us.' },
    ],
    whatYouGet: ['A focused 1:1 career consultation', 'A concrete action plan', 'Honest, experienced feedback', 'Resume/LinkedIn notes on request'],
    whoFor: ['Anyone considering a career switch', 'People preparing for interviews or promotions', 'Early-career professionals wanting direction'],
    notFor: ['Anyone wanting a guaranteed job placement', 'Those looking for legal employment advice'],
    faq: [
      { q: 'Should I send my resume beforehand?', a: 'Haan, please — it helps us use the call time on strategy instead of a read-through.' },
      { q: 'Can we do more than one session?', a: 'Of course — book again any time for a follow-up on your progress.' },
      { q: 'Do you guarantee results?', a: 'No consultant can guarantee an offer — what I guarantee is a clear, honest plan.' },
    ],
    sampleQa: [
      { q: 'How do I switch careers with no direct experience?', a: 'We’ll find your transferable skills and build a story that connects your past work to the new role.' },
      { q: 'How should I negotiate my next offer?', a: 'We’ll go through your leverage points and script the actual conversation.' },
    ],
    credential: 'Career Coach',
  },
  ai_bestie: {
    howItWorks: [
      { label: 'Say hi', body: 'Start chatting any time — no booking a slot, your AI bestie is always awake.' },
      { label: 'Talk it out', body: 'Vent, ask for advice, or just chat about your day — judgment-free, always.' },
      { label: 'Get a perspective', body: 'Thoughtful replies, not generic ones — trained to actually listen.' },
      { label: 'Come back anytime', body: 'Pick up the conversation whenever — it remembers your last chat.' },
    ],
    houseRulesIntro: 'Ek dost jo hamesha available hai — but kuch cheezein yeh nahi kar sakta.',
    houseRules: [
      { heading: 'Not a medical or legal service', body: 'For real emergencies or diagnoses, please talk to a real professional.' },
      { heading: 'Be respectful', body: 'The AI will disengage from abusive or harmful requests.' },
      { heading: 'Private by design', body: 'Your chats are yours — not used to train on your personal details.' },
      { heading: 'It’s AI, not a human', body: 'Warm and responsive, but it’s a trained model, not a licensed therapist.' },
    ],
    whatYouGet: ['24/7 chat availability', 'A warm, judgment-free listener', 'Conversation memory across chats', 'Support in Hindi and English'],
    whoFor: ['Anyone who wants to vent or think out loud', 'People who want a friendly chat at 3 AM', 'Those easing into talking about their feelings'],
    notFor: ['Anyone in a medical or safety emergency (please call a real helpline)', 'Those needing a licensed therapist or doctor'],
    faq: [
      { q: 'Is this a real person?', a: 'Nahi, this is an AI companion — friendly and responsive, but not a human.' },
      { q: 'Is it available at night?', a: 'Haan, 24/7 — that’s the whole point of a bestie who never sleeps.' },
      { q: 'Can it help in an emergency?', a: 'No — for a real emergency, please contact a licensed professional or helpline immediately.' },
    ],
    sampleChat: [
      { who: 'You', line: 'I bombed my interview today, feeling so low.' },
      { who: 'AI Bestie', line: 'Ugh, that’s such a rough feeling. Want to talk through what happened, or just vent for a bit first?' },
      { who: 'You', line: 'I just froze on one question and couldn’t recover.' },
      { who: 'AI Bestie', line: 'That happens to literally everyone at least once — it doesn’t erase everything else you brought to that room.' },
    ],
    canDo: ['Listen and chat about your day', 'Help you think through a decision', 'Keep a conversation going 24/7'],
    cantDo: ['Give medical, legal or financial advice', 'Handle a safety emergency', 'Replace a licensed therapist'],
  },
  generic: {
    howItWorks: [
      { label: 'Join', body: 'Hop in at the start time — details land in your inbox beforehand.' },
      { label: 'The session', body: 'We go through what’s promised in the listing, live.' },
      { label: 'Your questions', body: 'Ask anything relevant along the way.' },
      { label: 'Wrap-up', body: 'A quick close and next steps if there are any.' },
    ],
    houseRulesIntro: 'Ek simple si guideline — respect sabke liye, maza sabke liye.',
    houseRules: [
      { heading: 'Be on time', body: 'We start promptly — try to join a few minutes early.' },
      { heading: 'Be respectful', body: 'Keep the chat and mic friendly for everyone in the room.' },
      { heading: 'Come prepared', body: 'Check the listing for anything you should bring or set up beforehand.' },
      { heading: 'Ask questions', body: 'This works best when you’re an active participant, not a silent viewer.' },
    ],
    whatYouGet: ['A live, hosted session', 'Direct access to ask questions', 'A focused block of the host’s time'],
    whoFor: ['Anyone interested in this topic', 'People who prefer live over recorded content'],
    notFor: ['Anyone looking for a fully self-paced course'],
    faq: [
      { q: 'What do I need to prepare?', a: 'Check the listing description — most sessions need nothing more than showing up.' },
      { q: 'What if I’m late?', a: 'You can still join, but you may miss the opening context.' },
      { q: 'Is there a replay?', a: 'Only if the listing says so — otherwise this is a live-only session.' },
    ],
  },
};

export function defaultsFor(category: string, kind: string): ListingContentDefaults {
  return DEFAULTS[flavorFor(category, kind)];
}

/* [LIST-WIZ-CAT-1] `/api/explore/categories` (worker/src/routes/listings.ts
 * exploreCategories) returns EVERY row in `listing_categories` — the
 * marketplace-goods ids (cars, bikes, properties, mobiles, furniture,
 * fashion, jobs, …) right alongside the service/creator ones. The endpoint
 * carries no per-row "kind" to filter on, so a live_event/consult listing in
 * this wizard would otherwise show a goods category in its dropdown.
 *
 * This is the one allowlist: every id a live_event/consult/ai_agent listing
 * may pick. Kept here (not in steps.tsx) so it sits next to flavorFor(), the
 * other place category ids are enumerated by hand, and so a real DB id added
 * to worker/migrations/*.sql without a matching entry here is easy to spot
 * in review rather than silently hidden from every creator's dropdown.
 */
export const SERVICE_CATEGORY_IDS = new Set([
  'teachers', 'astrologers', 'professors', 'fitness', 'music', 'cooking',
  'business', 'language', 'art', 'wellness', 'live_friends', 'adda_rooms',
  'glow_up', 'services', 'other',
]);

export default DEFAULTS;
