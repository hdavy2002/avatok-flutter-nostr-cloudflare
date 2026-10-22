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
      { q: `What is ${B}?`, a: `${B} is an Indian platform where you can talk to your favourite social media influencer (YouTube, Instagram, Facebook and more) over a private phone call, paid by the minute. You pick an influencer, check their per-minute rate and book a call. Your phone number and the influencer's phone number both stay private.` },
      { q: 'How does a call actually work?', a: `We are a switch, not a phone company and not a listening room. When you book or start a call, our system first calls the influencer and announces that you want to talk. If the influencer accepts, we call you and join the two calls together. Both calls come from a ${B} number, so neither of you ever sees the other's personal number. No human listens in.` },
      { q: `Is ${B} a dating or adult chat service?`, a: 'No. Flirting, sexual talk, asking for photos, exchanging numbers or social media IDs and arranging to meet are not allowed. The only exception is a genuine health conversation (for example periods, PCOS, menopause or sexual health) with an influencer who has openly agreed to that topic — see <a href="#conduct">What is allowed</a>.' },
      { q: 'What can I do on it?', a: 'Talk to an influencer you follow: ask about their work, their content or their story, share what you enjoyed, or simply say hello. It is a friendly conversation with someone you admire, not professional advice.' },
      { q: 'Is this therapy, counselling or professional advice?', a: `No. Influencers are not doctors, lawyers, counsellors or financial advisors on ${B}, and nothing said on a call is professional advice. If you are in crisis, call <a href="tel:14416">Tele-MANAS 14416</a> (free, 24×7) or <a href="tel:112">112</a>.` },
      { q: 'Where do the videos come from?', a: "From the influencer's own YouTube and Instagram. They play in YouTube's and Instagram's official players. We do not copy, download or store videos." },
      { q: 'Is it only for India?', a: 'Yes. The service is built for India: Indian phone numbers, rupee payments and Indian languages. For now, we only take on influencers based in India.' },
      { q: 'Which languages can I talk in?', a: 'Every influencer lists the languages they are comfortable in — Hindi, English, Marathi, Kannada and more. Use the language filter to find someone who speaks yours.' },
    ],
  },
  {
    id: 'start', title: 'Getting started', hindi: 'Shuruaat kaise karein', icon: '✳', tone: 'pink',
    items: [
      { q: 'Is it free to join?', a: 'Yes. Creating an account is free for callers and influencers. Callers only pay for connected call minutes. There is no subscription.' },
      { q: 'Who can use it?', a: 'Only adults aged 18 or over. See our <a href="/age-policy">age policy</a>.' },
      { q: 'How do I sign up?', a: 'Sign up with a one-time code sent to your WhatsApp or email. We never ask for a password, and we will never ask you to read an OTP out to anyone.' },
      { q: 'Do I need to install an app?', a: 'No. Calls come to your normal phone number like any other call. You manage your wallet, favourites and history on the website.' },
      { q: 'What do I need?', a: 'An Indian mobile number, a phone with normal network coverage, and a way to pay to add money to your wallet.' },
      { q: 'Can I be a caller and an influencer?', a: 'Yes, on the same account. Create your account, then upgrade to influencer for free from your dashboard.' },
      { q: 'How do I delete my account?', a: 'Follow the steps on <a href="/data-deletion">data deletion</a>. Withdraw your wallet money with the Payout button first.' },
    ],
  },
  {
    id: 'callers', title: 'For callers', hindi: 'Call karne waalon ke liye', icon: '✷', tone: 'lilac',
    items: [
      { q: 'How do I start a call?', a: 'Add money to your wallet (you need at least ₹20), pick an influencer who is online, check their price, and tap call. We call the influencer first. Once they accept, your phone rings and we join the two calls.' },
      { q: 'How do I find an influencer?', a: 'Filter by category and language. Each profile shows the topics that influencer has agreed to talk about and their per-minute price.' },
      { q: 'Can I end a call whenever I want?', a: 'Yes. Simply hang up. You can also press <b>#</b> at any time to end the call and block that person.' },
      { q: 'What if the influencer I want is offline?', a: 'Add them to your favourites and tap “Notify me”. You will know when they come online. You can also book a time: the booking holds 10 minutes of their rate in your wallet, and you can cancel free until 1 hour before.' },
      { q: 'Can I call the same person again?', a: 'Yes — that is what favourites are for. Your number stays private every single time.' },
      { q: 'An influencer asked me to pay outside the platform or to share my number. What do I do?', a: 'Do not pay and do not share anything. End the call and <a href="/report">report the influencer</a>. Asking for money, UPI IDs or contact details outside the platform is a serious violation and leads to removal.' },
    ],
  },
  {
    id: 'privacy', title: 'Privacy & your number', hindi: 'Aapka number, sirf aapka', icon: '❖', tone: 'paper',
    items: [
      { q: 'Will the other person see my phone number?', a: 'Never. Both calls come from a platform number. Your personal number is not shown on any profile, call screen or bill to the other person, and the influencer\'s personal number is never shown to you.' },
      { q: 'Does anyone listen to my calls?', a: 'No. No human monitors or listens to your calls, and your number stays masked.' },
      { q: 'What do you keep about a call?', a: 'Only what is needed to run the service and bill fairly: who called whom (as account IDs), time, duration, charge, and how the call ended. Read our <a href="/privacy">privacy policy</a>.' },
      { q: 'Is there anything number masking cannot hide?', a: 'Masking hides your number, not what you say. Do not share your full name, address, workplace, social media, bank details or OTPs on a call. A real friend never needs your OTP.' },
      { q: 'Is my phone number safe?', a: 'Yes. Every call goes through our masked line. Influencers and callers never see each other\'s number.' },
      { q: 'Are the profile photos real?', a: 'Profile pictures and gallery images may be AI-generated, and they are labelled as AI-generated when they are. The voice introduction you can play on a profile is the influencer\'s own recording, labelled "Recorded by the influencer". The person you talk to is the real influencer.' },
      { q: 'Will you ever sell my data?', a: 'Never. We follow India\'s Digital Personal Data Protection Act, 2023 and the DPDP Rules, 2025. Your data is used only to run the service, pay influencers, keep people safe and meet the law. Read <a href="/help/safety-and-privacy/how-we-protect-your-data">how we protect your data</a>.' },
      { q: 'How do I delete my data?', a: 'Go to your account and choose &ldquo;Delete my account&rdquo;, or write to our <a href="/grievance">Grievance Officer</a>. We delete your data, except records the law requires us to keep for a while. See <a href="/data-deletion">data deletion</a>.' },
      { q: 'How do I find LGBTQ+ friendly influencers?', a: 'Influencers can choose to show <b>LGBTQ+ friendly</b> on their profile. Customers are never asked about their orientation. Influencers on the monthly influencer plan can also take calls from verified customers only. Read more on <a href="/lgbtq">LGBTQ+ safety</a>.' },
    ],
  },
  {
    id: 'ai-safety', title: 'Safety & scam protection', hindi: 'Surakshit raho', icon: '✦', tone: 'peach',
    items: [
      { q: 'How are calls kept safe?', a: 'Your number and the influencer\'s number stay masked. You can press <b>#</b> at any time to end the call and block the person, and you can report anyone. Our team reviews reports, and serious or repeated violations lead to strikes and bans. No human monitors your call, and your number stays masked.' },
      { q: 'Do you listen to calls to check them?', a: 'No. Nobody monitors what you say. Safety comes from masked numbers, your own control to end and block with <b>#</b>, and reports that our team reviews.' },
      { q: 'What kinds of scam calls should I watch out for?', a: 'Anyone posing as a bank, telecom, courier, police or government officer; anyone asking for an OTP, UPI PIN, card details, Aadhaar number or bank details; anyone sending “verify your account” links; and anyone pushing products, loans, investments or remedies. End the call, press <b>#</b> to block them and <a href="/report">report</a> it.' },
      { q: 'What happens to a scammer after they are reported?', a: 'Our team reviews the report. If it is confirmed, the account can be banned from the platform.' },
      { q: 'Will you ever call me and ask for an OTP?', a: `Never. ${B} will never ask for your OTP, UPI PIN, password or bank details — not on a call, not on WhatsApp, not by email. Anyone who asks is a scammer.` },
      { q: 'What if I think an account restriction was wrong?', a: 'No process is perfect. If you think your account was restricted wrongly, raise it through <a href="/grievance">grievance redressal</a> and a person on our team will review it.' },
      { q: 'What do strikes and bans mean?', a: 'Serious or repeated violations lead to strikes. Three confirmed strikes means a permanent ban. Some acts — threats, sexual harassment or fraud — can lead to an immediate ban. A banned account cannot make calls, but can still sign in to the dashboard and withdraw any wallet balance to UPI.' },
      { q: 'I feel very low. Can an influencer help me?', a: 'Influencers are friendly listeners, not counsellors. If you feel hopeless or think about hurting yourself, please call <a href="tel:14416">Tele-MANAS 14416</a> (free, 24×7) or <a href="tel:112">112</a>. Sharing how you feel is never a reason for a strike, and an influencer may give you these numbers and end the call so you can get real help.' },
      { q: 'Is this an emergency service?', a: 'No. If you or someone else is in danger, call <a href="tel:112">112</a>. For mental-health support call <a href="tel:14416">Tele-MANAS 14416</a>.' },
    ],
  },
  {
    id: 'women', title: 'Safety for women', hindi: 'Mahilaon ke liye', icon: '♥', tone: 'pink',
    items: [
      { q: 'Is it safe for women to take or make calls?', a: 'Women’s safety is the main reason the platform is built the way it is: numbers are never shared, and a woman can end and block any caller instantly with <b>#</b>. Payment never buys permission to cross a boundary.' },
      { q: 'What if a man starts flirting or saying sexual things?', a: 'Press <b>#</b> or hang up — you owe nobody an explanation. Then <a href="/report">report</a> it. After our team reviews the report the caller can get a strike, and repeat offenders are banned.' },
      { q: 'Can a woman influencer choose who calls her?', a: 'Yes. Influencers on the monthly influencer plan can turn on <b>Verified customers only</b>, so only customers who have completed full KYC can call them. Every influencer can decline any call and press <b>#</b> to end and block. Read more on <a href="/women-only">women&rsquo;s safety</a>.' },
      { q: 'Does verification check that the caller is a woman?', a: 'No. Full KYC confirms who the customer is, not their gender, and it does not guarantee behaviour. All the usual safety rules still apply.' },
      { q: 'Can we talk about periods, PCOS, pregnancy or intimate health?', a: 'Yes, with an influencer who lists women&rsquo;s health as a topic on their profile. Harassment and sexual pressure are still not allowed.' },
      { q: 'What if a caller lies about who they are?', a: 'Press <b>#</b> to end the call and block, and report the account. Our team reviews every report, and anyone found misleading influencers is banned.' },
    ],
  },
  {
    id: 'conduct', title: 'What is allowed', hindi: 'Kya chalega, kya nahi', icon: '✿', tone: 'lilac',
    items: [
      { q: 'Is sexual talk allowed?', a: 'No. Sexual or suggestive talk is not allowed anywhere on the platform. The only exception is a genuine medical or health conversation with an influencer who has specifically consented to that topic — for example an influencer who lists women&rsquo;s health or sexual-health discussion as a topic on their profile. Even then, explicit or erotic talk is not allowed.' },
      { q: 'Can an influencer be my girlfriend or boyfriend?', a: 'No. Influencers are independent people offering friendly conversation. This is not a dating or relationship service, and influencers will not flirt, share their number or meet you. See <a href="/wellbeing">use it in a healthy way</a>.' },
      { q: 'Is there a limit on how much I can call one influencer?', a: 'When calling launches there will be healthy-use limits: a daily time limit with the same influencer, and a short cooling-off gap. If a limit applies you see “This influencer isn’t available right now” — it is a platform rule, not a rejection by the influencer.' },
      { q: 'How do I know what an influencer is willing to talk about?', a: 'Every influencer chooses their topics and that consent is shown on their profile. Please stay within the topics they listed.' },
      { q: 'What else is not allowed?', a: 'Abuse, threats or gaali; asking for or sharing phone numbers, WhatsApp, Instagram or UPI IDs; arranging to meet; selling anything (products, remedies, tips, loans); asking for money; and anyone under 18. See <a href="/community-guidelines">community guidelines</a>.' },
      { q: 'What happens if someone breaks the rules?', a: 'The call can end immediately, the account receives a strike, and serious or repeated cases are banned permanently.' },
    ],
  },
  {
    id: 'influencers', title: 'For influencers', hindi: 'Fans se baat karo, paise kamao', icon: '☀', tone: 'cream',
    items: [
      { q: 'Who can become an influencer on the platform?', a: 'Any adult in India with their own mobile number and 10 or more followers who wants to take calls from fans. For now, we only take on Indian influencers. Create a free account, then upgrade to influencer for free from your dashboard. Connect YouTube by signing in with it, or Instagram with a short code in your bio. Joining needs no ID check. Start at <a href="/hosts/join">Join &amp; earn</a>.' },
      { q: 'How much can I earn?', a: 'You set your own per-minute rate, as you see fit. Fans are charged for every connected minute of the phone call. We keep ₹2 a minute plus 40% of the rate above ₹2, and you keep the rest. At ₹20 a minute you earn ₹10.80 a minute. Being online does not guarantee calls. See <a href="/hosts/rates">rates</a>.' },
      { q: 'How do I get paid?', a: 'Your earnings are credited after each completed call and held for 7 days. After that, tap the Payout button and we send the money to your UPI, in your own name. We do a one-time ID (KYC) check and a UPI check before your first payout.' },
      { q: 'Can I choose when I take calls?', a: 'Yes. Go online when you are free and offline whenever you want. You can decline any call before it connects.' },
      { q: 'Do you train influencers?', a: 'Yes. We run regular awareness training for influencers on spotting spam, scam and fraud calls — callers asking for OTPs, bank details, “KYC update” tricks, sextortion attempts and emotional manipulation — and on how to end and report them safely.' },
      { q: 'What if a caller seems very low or gets too attached to me?', a: 'Follow the <a href="/hosts/crisis-script">welfare & crisis guide</a>: stay kind, give Tele-MANAS 14416 and 112, never flirt or promise anything, and flag the caller. The platform — not you — limits contact, and the caller only sees that you are not available.' },
      { q: 'What if a caller is rude or unsafe?', a: 'Press <b>#</b> at any time: the call ends, the caller is blocked from calling you again and the incident is reported. You never have to finish a call that feels wrong.' },
      { q: 'Will callers see my real number or name?', a: 'No. Callers see only your display name and profile. Your number and personal details stay private.' },
      { q: 'Can I ask a caller to pay me directly?', a: 'No. Payments outside the platform are a serious violation and lead to removal. They also remove every protection we give you.' },
    ],
  },
  {
    id: 'payments', title: 'Payments, wallet & refunds', hindi: 'Paisa aur wallet', icon: '₹', tone: 'paper',
    items: [
      { q: 'How do I pay for calls?', a: 'You add money to a prepaid talk-time wallet on the wallet page. You can add any amount from ₹10. 18% GST is deducted from what you pay, so your wallet gets the amount divided by 1.18: pay ₹120, ₹18.31 GST is deducted and ₹101.69 is added. Each call is charged from that wallet at the per-minute rate set by the influencer, which you see before you call.' },
      { q: 'When does charging start?', a: 'A call is made once we have rung both of you and joined the call. You pay per minute spoken. If the influencer declines, cancels or does not answer, you pay nothing.' },
      { q: 'How are minutes counted?', a: 'By the minute, at the influencer\'s rate. You need at least ₹20 in your wallet to start a call.' },
      { q: 'What happens when my wallet runs low?', a: 'You hear "one minute left" before your wallet money ends, then the call ends automatically. You can never go into debt.' },
      { q: 'What if a call breaks in the first minute?', a: 'If a joined call breaks within the first minute, we charge ₹1 and return the rest to your wallet.' },
      { q: 'Do you give refunds?', a: 'We do not refund calls that were made, except the first-minute rule above. You choose the influencer, see the price before calling and can hang up at any second, so you only pay for the minutes you spoke. See the <a href="/refunds">refund policy</a>.' },
      { q: 'I didn’t like my call with an influencer. Can I get my money back?', a: `No. ${B} connects you with an independent influencer; we are not responsible for how a particular conversation went, so we cannot refund a call because the experience was not what you hoped. Leave a rating, try someone else, and report the influencer if they broke a rule.` },
      { q: 'What happens if I book a call and cancel?', a: 'A booked call holds 10 minutes of the influencer\'s rate in your wallet. You can cancel free until 1 hour before, and the hold comes back to your wallet. If the influencer does not pick up at the booked time, the full hold comes back. If the influencer cancels, it always comes back.' },
      { q: 'Where do refunds go?', a: 'All refunds go back to your wallet, never to your card or UPI.' },
      { q: 'Can I take my wallet money out?', a: 'Yes. Anyone can withdraw wallet money with the Payout button. We send it to your UPI after a one-time ID (KYC) and UPI check. Test credits can be spent but not withdrawn.' },
      { q: 'What happens to my wallet if my account is banned?', a: 'A banned account can no longer make calls, but you can still sign in and withdraw wallet money with the Payout button. Wallet money is never taken away as a penalty.' },
      { q: 'What if I was charged twice, or for a call that was never made?', a: 'That is a billing error, not a refund request. <a href="/report">Report it</a> with the call ID and time. It will be checked against the call details, and the wrong amount is put back in your wallet, linked to that call.' },
      { q: 'Do I get a receipt?', a: 'Every addition to your wallet and every call charge appears in your wallet history with the date, duration and amount.' },
    ],
  },
  {
    id: 'partners', title: 'For payment & compliance partners', hindi: 'Gateway aur partners ke liye', icon: '◆', tone: 'peach',
    items: [
      { q: 'What does the business sell?', a: 'Paid phone calls between adult influencers and adult fans in India, charged per minute at the influencer\'s rate. Customers add money to a rupee wallet and spend it on call minutes. Influencers can choose an optional monthly influencer plan with extra call controls. There are no physical goods, digital downloads or adult content.' },
      { q: 'Who are the service providers on the platform?', a: 'Influencers: independent adult individuals based in India. Earnings are paid out only to a bank account or UPI ID in the influencer’s own name.' },
      { q: 'How do you prevent adult or prohibited content?', a: 'Sexual content is banned by our rules, influencer agreement and community guidelines. Reports are reviewed by our team, and violators receive strikes and bans. Limited, consented medical and intimate-health discussion is allowed only with influencers who opt in to that topic on their profile.' },
      { q: 'How do you prevent fraud on the platform?', a: 'Masked numbers, OTP and bank-detail scam warnings, press-<b>#</b> blocking, bans after team review, regular influencer training on scam awareness, and a rule that no money moves outside the platform.' },
      { q: 'Does anyone monitor or store call content?', a: 'No human monitors live calls. We keep call details (participants as account IDs, time, duration, charge) for billing and dispute handling.' },
      { q: 'How are minors kept off the platform?', a: 'Accounts are 18+ only, and accounts that appear to belong to a minor are suspended.' },
      { q: 'What is the refund and dispute policy?', a: 'Calls that were made are not refunded, except when a joined call breaks in the first minute (we charge ₹1 and return the rest). Customers pay only for the minutes they spoke, after seeing the price. If the influencer declines, cancels or does not answer, nothing is charged. All refunds go to the customer\'s wallet, never to a card or UPI, and wallet money can be withdrawn to UPI after a one-time ID and UPI check. Billing errors are corrected against call details.' },
      { q: 'How do customers raise complaints?', a: 'Through our <a href="/grievance">grievance redressal</a> page and <a href="/contact">contact</a> page, as required under the IT Rules, 2021.' },
    ],
  },
  {
    id: 'tech', title: 'Call problems', hindi: 'Network ki dikkat?', icon: '☎', tone: 'cream',
    items: [
      { q: 'The call dropped. Am I still charged?', a: 'Charging stops the moment the call disconnects. You only pay for the minutes you spoke. If a joined call breaks within the first minute, we charge ₹1 and return the rest to your wallet.' },
      { q: 'My phone did not ring.', a: 'Check that your number is correct in your account, that you have network coverage, and that call-blocking or DND apps are not blocking unknown numbers.' },
      { q: 'The voice was breaking up.', a: 'Calls run on the normal mobile network, so move to a spot with better signal. If it keeps happening with one influencer, try someone else and let us know.' },
      { q: 'Who do I contact about a problem?', a: `Write to <a href="mailto:${BRAND.emails.support}">${BRAND.emails.support}</a> with the call ID, date and time. Never send an OTP, UPI PIN or card details.` },
    ],
  },
];

export const faqCount = faqSections.reduce((n, s) => n + s.items.length, 0);
