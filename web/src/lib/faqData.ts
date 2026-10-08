// [HELLO-FRAANDS-FAQ-1] Content for /faq. Answers are trusted HTML (links only).
// Never type the brand name or domain here — use B / BRAND (Specs/brand.json).
import { BRAND } from './brand';

const B = BRAND.name;

export interface FaqItem { q: string; a: string }
export interface FaqSection { id: string; title: string; hindi: string; icon: string; tone: 'cream' | 'pink' | 'lilac' | 'paper' | 'peach'; items: FaqItem[] }

export const faqSections: FaqSection[] = [
  {
    id: 'about', title: `About ${B}`, hindi: 'Hum kaun hain', icon: '❋', tone: 'cream',
    items: [
      { q: `What is ${B}?`, a: `${B} is an Indian platform where you can talk to a real person on a normal phone call, in your language, and pay per minute. Callers pick a host by mood, language and price. Hosts are verified adults who earn from home by talking. Neither person ever sees the other's phone number.` },
      { q: 'How does a call actually work?', a: `We are a switch, not a phone company and not a listening room. When you tap call, our system rings the host first. Once the host accepts, it rings you and joins the two calls together through a platform number. Your personal numbers never pass to each other. While the call is live, our AI keeps an eye on the conversation for safety, and the call ends automatically if it detects abuse, harassment or a scam attempt.` },
      { q: `Is ${B} a dating or adult chat service?`, a: 'No. Flirting, sexual talk, asking for photos, exchanging numbers or social media IDs and arranging to meet are not allowed. The only exception is a genuine health conversation (for example periods, PCOS, menopause or sexual health) with a host who has openly agreed to that topic — see <a href="#conduct">What is allowed</a>.' },
      { q: 'What do people use it for?', a: 'Everyday conversation: a rough day, exam or interview nerves, loneliness at night, wedding or family tension, practising a language, or simply making a new friend to call again tomorrow. It is about company and being heard.' },
      { q: 'Is this therapy, counselling or professional advice?', a: `No. Hosts are not doctors, lawyers, counsellors or financial advisors on ${B}, and nothing said on a call is professional advice. If you are in crisis, call <a href="tel:14416">Tele-MANAS 14416</a> (free, 24×7) or <a href="tel:112">112</a>.` },
      { q: 'Is it only for India?', a: 'Yes. The service is built for India: Indian phone numbers, UPI payments, Indian languages and Indian KYC (Aadhaar).' },
      { q: 'Which languages can I talk in?', a: 'Every host lists the languages they are comfortable in — Hindi, English, Marathi, Kannada and more. Use the language filter to find someone who speaks yours.' },
    ],
  },
  {
    id: 'start', title: 'Getting started', hindi: 'Shuruaat kaise karein', icon: '✳', tone: 'pink',
    items: [
      { q: 'Is it free to join?', a: 'Yes. Creating an account is free for callers and hosts. Callers only pay for connected call minutes. There is no subscription.' },
      { q: 'Who can use it?', a: 'Only adults aged 18 or over. Hosts must also pass video KYC and Aadhaar verification before they can take a single call. See our <a href="/age-policy">age policy</a>.' },
      { q: 'How do I sign up?', a: 'Sign up with a one-time code sent to your WhatsApp or email. We never ask for a password, and we will never ask you to read an OTP out to anyone.' },
      { q: 'Do I need to install an app?', a: 'No. Calls come to your normal phone number like any other call. You manage your wallet, favourites and history on the website.' },
      { q: 'What do I need?', a: 'An Indian mobile number, a phone with normal network coverage, and a UPI app to top up your wallet.' },
      { q: 'Can I be a caller and a host?', a: 'Yes, on the same account. Hosting unlocks only after your video KYC and Aadhaar checks are complete.' },
      { q: 'Why do you ask for my real identity if others only see my display name?', a: 'Hosts verify their identity so callers know they are real people, and to keep fake and abusive accounts out. Your legal name, Aadhaar details and phone number are never shown on your profile or shared with the person you talk to.' },
      { q: 'How do I delete my account?', a: 'Follow the steps on <a href="/data-deletion">data deletion</a>. Withdraw any wallet balance to your UPI first.' },
    ],
  },
  {
    id: 'callers', title: 'For callers', hindi: 'Call karne waalon ke liye', icon: '✷', tone: 'lilac',
    items: [
      { q: 'How do I start a call?', a: 'Top up your wallet by UPI, pick a host who is online, check their per-minute price, and tap call. The host accepts first, then your phone rings and you are connected.' },
      { q: 'How do I find the right person?', a: 'Filter by mood (for example “exam ki tension”, “can’t sleep”, “naye dost”), by language and by price. Each profile shows the topics that host has agreed to talk about.' },
      { q: 'Can I end a call whenever I want?', a: 'Yes. Simply hang up. You can also press <b>#</b> at any time to end the call and block that person.' },
      { q: 'What if the host I want is offline?', a: 'Add them to your favourites and tap “Notify me”. You will know when they come online.' },
      { q: 'Can I call the same person again?', a: 'Yes — that is what favourites are for. Many callers build a regular friend they talk to every week, and your number stays private every single time.' },
      { q: 'A host asked me to pay outside the platform or to share my number. What do I do?', a: 'Do not pay and do not share anything. End the call and <a href="/report">report the host</a>. Asking for money, UPI IDs or contact details outside the platform is a serious violation and leads to removal.' },
    ],
  },
  {
    id: 'privacy', title: 'Privacy & your number', hindi: 'Aapka number, sirf aapka', icon: '❖', tone: 'paper',
    items: [
      { q: 'Will the other person see my phone number?', a: 'Never. Both of you see only a platform number. Your personal number is not shown on any profile, call screen or bill to the other person.' },
      { q: 'Are calls recorded?', a: 'No. We do not record calls and we do not store call audio.' },
      { q: 'Does anyone at your company listen to my calls?', a: 'No. No human monitors or listens to live calls. Safety on a live call is handled by AI, which looks at the conversation as it happens and does not keep a recording.' },
      { q: 'What do you keep about a call?', a: 'Only what is needed to run the service and bill fairly: who called whom (as account IDs), time, duration, price, and whether the call was ended by a person or by a safety action. Read our <a href="/privacy">privacy policy</a>.' },
      { q: 'Is there anything number masking cannot hide?', a: 'Masking hides your number, not what you say. Do not share your full name, address, workplace, social media, bank details or OTPs on a call. A real friend never needs your OTP.' },
      { q: 'Will you ever sell my data?', a: 'No. We do not sell personal data to anyone.' },
    ],
  },
  {
    id: 'ai-safety', title: 'AI safety & spam protection', hindi: 'AI dhyaan rakhta hai', icon: '✦', tone: 'peach',
    items: [
      { q: 'How does the AI keep calls safe?', a: 'Our AI follows the conversation in real time and understands what the caller is trying to do. If it detects harassment, abuse, sexual pressure, threats or a fraud attempt, it ends the call automatically and flags the account.' },
      { q: 'Does it just listen for bad words?', a: 'No. We do not use word triggers. A keyword list is easy to dodge and also punishes innocent people. The AI understands <i>intention</i> — the difference between someone describing a bad experience and someone being abusive, or between a normal chat and a slow build-up to “just tell me the OTP”.' },
      { q: 'What kinds of spam and scam calls do you stop?', a: 'Callers posing as a bank, telecom, courier, police or government officer; anyone asking for an OTP, UPI PIN, card details, Aadhaar number or bank details; anyone sending “verify your account” links; and anyone pushing products, loans, investments or remedies. These calls are cut and the number is blocked across the whole platform.' },
      { q: 'What happens to a spammer after they are caught?', a: 'Their account and phone number are blocked, so they cannot call any other host. Repeat attempts from new accounts are matched and blocked too.' },
      { q: 'Will you ever call me and ask for an OTP?', a: `Never. ${B} will never ask for your OTP, UPI PIN, password or bank details — not on a call, not on WhatsApp, not by email. Anyone who asks is a scammer.` },
      { q: 'What if the AI makes a mistake?', a: 'No system is perfect. If you think a call was ended unfairly or your account was restricted wrongly, raise it through <a href="/grievance">grievance redressal</a> and a person on our team will review it.' },
      { q: 'What do strikes and bans mean?', a: 'Serious or repeated violations lead to strikes. Three confirmed strikes means a permanent ban. Some acts — threats, sexual harassment or fraud — can lead to an immediate ban. A banned account cannot make calls, but can still sign in to the dashboard and withdraw any wallet balance to UPI.' },
      { q: 'Is this an emergency service?', a: 'No. If you or someone else is in danger, call <a href="tel:112">112</a>. For mental-health support call <a href="tel:14416">Tele-MANAS 14416</a>.' },
    ],
  },
  {
    id: 'women', title: 'Safety for women', hindi: 'Mahilaon ke liye', icon: '♥', tone: 'pink',
    items: [
      { q: 'Is it safe for women to host or call?', a: 'Women’s safety is the main reason the platform is built the way it is: numbers are never shared, every host is KYC-verified, AI ends abusive calls automatically, and a woman can end and block any caller instantly with <b>#</b>. Payment never buys permission to cross a boundary.' },
      { q: 'What if a man starts flirting or saying sexual things?', a: 'Press <b>#</b> or hang up — you owe nobody an explanation. The AI is also watching for exactly this and will end the call by itself. The caller gets a strike and repeat offenders are banned.' },
      { q: 'What is the women-only space?', a: 'A separate lane where only women talk to women. It is hidden from everyone else. Read more on <a href="/women-only">women-only space</a>.' },
      { q: 'How do you make sure only women enter it?', a: 'Both the caller and the host must complete video KYC <b>and</b> Aadhaar KYC showing they are women before the lane appears. An unverified account cannot see it or call into it.' },
      { q: 'Can we talk about periods, PCOS, pregnancy or intimate health there?', a: 'Yes. In the women-only space, health and intimate-wellness conversations are normal and the AI is tuned to understand them — describing a symptom or a bad experience will not get anyone flagged. Harassment and sexual pressure are still not allowed.' },
      { q: 'Can a man pretend to be a woman to get in?', a: 'Not without passing a live video KYC and an Aadhaar check, both in his own name. That is why both checks are mandatory for both sides.' },
    ],
  },
  {
    id: 'conduct', title: 'What is allowed', hindi: 'Kya chalega, kya nahi', icon: '✿', tone: 'lilac',
    items: [
      { q: 'Is sexual talk allowed?', a: 'No. Sexual or suggestive talk is not allowed anywhere on the platform. The only exception is a genuine medical or health conversation with a host who has specifically consented to that topic — for example in the women-only space, or with a host who lists sexual-health discussion as a topic on their profile. Even then, explicit or erotic talk is not allowed.' },
      { q: 'How do I know what a host is willing to talk about?', a: 'Every host chooses their topics and that consent is shown on their profile. Please stay within the topics they listed.' },
      { q: 'What else is not allowed?', a: 'Abuse, threats or gaali; asking for or sharing phone numbers, WhatsApp, Instagram or UPI IDs; arranging to meet; selling anything (products, remedies, tips, loans); asking for money; recording the other person without consent; and anyone under 18. See <a href="/community-guidelines">community guidelines</a>.' },
      { q: 'What happens if someone breaks the rules?', a: 'The call can end immediately, the account receives a strike, and serious or repeated cases are banned permanently.' },
    ],
  },
  {
    id: 'hosts', title: 'For hosts', hindi: 'Baatein karo, paise kamao', icon: '☀', tone: 'cream',
    items: [
      { q: 'Who can become a host?', a: 'Any adult in India with their own mobile number who is good at listening and talking, and who passes video KYC and Aadhaar verification. Start at <a href="/hosts/join">Join &amp; earn</a>.' },
      { q: 'How much can I earn?', a: 'You set your own per-minute rate. The platform keeps ₹2 per minute plus 40% of anything above ₹2 (GST included in the platform share) and the rest is yours. For example at ₹10/min you earn ₹4.80/min. See <a href="/hosts/rates">rates</a>. Calls are not guaranteed.' },
      { q: 'How do I get paid?', a: 'Your earnings are credited after each completed call and withdrawn to your own UPI ID.' },
      { q: 'Can I choose when I take calls?', a: 'Yes. Go online when you are free and offline whenever you want. You can decline any call before it connects.' },
      { q: 'Do you train hosts?', a: 'Yes. We run regular awareness training for hosts on spotting spam, scam and fraud calls — callers asking for OTPs, bank details, “KYC update” tricks, sextortion attempts and emotional manipulation — and on how to end and report them safely.' },
      { q: 'What if a caller is rude or unsafe?', a: 'Press <b>#</b> at any time: the call ends, the caller is blocked from calling you again and the incident is reported. You never have to finish a call that feels wrong.' },
      { q: 'Will callers see my real number or name?', a: 'No. Callers see only your display name and profile. Your number and KYC details stay private.' },
      { q: 'Can I ask a caller to pay me directly?', a: 'No. Payments outside the platform are a serious violation and lead to removal. They also remove every protection we give you.' },
    ],
  },
  {
    id: 'payments', title: 'Payments, wallet & refunds', hindi: 'Paisa aur wallet', icon: '₹', tone: 'paper',
    items: [
      { q: 'How do I pay for calls?', a: 'You top up a prepaid talk-time wallet with UPI. Each call is charged per minute from that wallet. The host’s price is shown before you call, starting from ₹5/min.' },
      { q: 'When does charging start?', a: 'Only once both of you are connected. Ringing, a host declining, or a call that never connects costs nothing.' },
      { q: 'How are minutes counted?', a: 'Per started minute of connected time. For example, 61 seconds at ₹5/min is two minutes, ₹10. You need at least two minutes of balance to start a call.' },
      { q: 'What happens when my wallet runs low?', a: 'You get a warning shortly before your balance runs out, then the call ends automatically. You can never go into debt.' },
      { q: 'Do you give refunds?', a: 'No. We do not offer refunds for calls that took place. You choose the host, see their price before calling and can hang up at any second, so you are only ever charged for the time you chose to stay on the call. See the <a href="/refunds">refund policy</a>.' },
      { q: 'I didn’t like my call with a host. Can I get my money back?', a: `No. ${B} connects you with an independent host; we are not responsible for how a particular conversation went, so we cannot refund a call because the experience was not what you hoped. Leave a rating, try someone else, and report the host if they broke a rule.` },
      { q: 'Can I take my unused wallet balance out?', a: 'Yes. Any amount sitting in your wallet can be transferred back to your own UPI ID.' },
      { q: 'What happens to my wallet if my account is banned?', a: 'A banned account can no longer make calls, but you can still sign in to your dashboard and withdraw the remaining balance to your own UPI ID. Wallet money is never taken away as a penalty.' },
      { q: 'What if I was charged for a call that never connected?', a: 'That is a billing error, not a refund request. <a href="/report">Report it</a> with the call ID and time and it will be checked against the call records and corrected.' },
      { q: 'Do I get a receipt?', a: 'Every top-up and call charge appears in your wallet history with the date, duration and amount.' },
    ],
  },
  {
    id: 'partners', title: 'For payment & compliance partners', hindi: 'Gateway aur partners ke liye', icon: '◆', tone: 'peach',
    items: [
      { q: 'What does the business sell?', a: 'Prepaid talk-time for per-minute voice calls between verified adults in India. Customers top up a wallet by UPI and spend it on connected call minutes. There are no physical goods, subscriptions, digital downloads or adult content.' },
      { q: 'Who are the service providers on the platform?', a: 'Hosts: independent adult individuals who pass video KYC and Aadhaar verification before they can earn. Earnings are paid out only to a UPI ID in the host’s own name.' },
      { q: 'How do you prevent adult or prohibited content?', a: 'Sexual content is banned by our rules, host agreement and community guidelines. Real-time AI understands conversation intent and ends violating calls automatically; violators receive strikes and bans. Limited, consented medical and intimate-health discussion is allowed only with hosts who opt in to that topic, and in the KYC-verified women-only space.' },
      { q: 'How do you prevent fraud on the platform?', a: 'Verified hosts, masked numbers, AI detection of social-engineering and OTP/bank-detail scams, platform-wide blocking of spam numbers, regular host training on scam awareness, and a rule that no money moves outside the platform.' },
      { q: 'Do you record or store call content?', a: 'No. Calls are not recorded and audio is not stored. No human monitors live calls. We keep call metadata (participants as account IDs, time, duration, charge) for billing and dispute handling.' },
      { q: 'How are minors kept off the platform?', a: 'Accounts are 18+ only. Hosts are age-verified through KYC, and accounts that appear to belong to a minor are suspended.' },
      { q: 'What is the refund and dispute policy?', a: 'Connected call minutes are not refundable. Customers are charged only for connected time they chose, after seeing the price. Unused wallet balance can be withdrawn to the customer’s own UPI ID at any time — including after a ban, which stops calling but never forfeits the wallet. Billing errors (for example a charge for an unconnected call) are corrected against call records.' },
      { q: 'How do customers raise complaints?', a: 'Through our <a href="/grievance">grievance redressal</a> page and <a href="/contact">contact</a> page, as required under the IT Rules, 2021.' },
    ],
  },
  {
    id: 'tech', title: 'Call problems', hindi: 'Network ki dikkat?', icon: '☎', tone: 'cream',
    items: [
      { q: 'The call dropped. Am I still charged?', a: 'Charging stops the moment the call disconnects. You only pay for the minutes that were connected.' },
      { q: 'My phone did not ring.', a: 'Check that your number is correct in your account, that you have network coverage, and that call-blocking or DND apps are not blocking unknown numbers.' },
      { q: 'The voice was breaking up.', a: 'Calls run on the normal mobile network, so move to a spot with better signal. If it keeps happening with one host, try someone else and let us know.' },
      { q: 'Who do I contact about a problem?', a: `Write to <a href="mailto:${BRAND.emails.support}">${BRAND.emails.support}</a> with the call ID, date and time. Never send an OTP, UPI PIN or card details.` },
    ],
  },
];

export const faqCount = faqSections.reduce((n, s) => n + s.items.length, 0);
