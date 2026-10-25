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
      { q: 'How do I sign up?', a: 'Tap Create an account and enter your name, email and WhatsApp number. We send one code to your email and one on WhatsApp, and you type both. After that you log in with just a code on WhatsApp, or with Google (we still verify your WhatsApp number once). We never ask for a password, and we will never ask you to read an OTP out to anyone.' },
      { q: 'Do I need to install an app?', a: 'No. Calls come to your normal phone number like any other call. You manage your wallet, favourites and history on the website.' },
      { q: 'What do I need?', a: 'An Indian mobile number, a phone with normal network coverage, and a way to pay to add money to your wallet.' },
      { q: 'Can I be a caller and an influencer?', a: 'Yes, on the same account. Create your account, then upgrade to influencer for free from your dashboard.' },
      { q: 'How do I close my account?', a: 'Open <b>Close my account</b> in your dashboard (or see <a href="/data-deletion">data deletion</a>). We settle your money first: your wallet balance, as your Wallet page shows it after GST, is paid to your own UPI ID in whole rupees, and the part below ₹1 is not paid. You need your UPI ID and the one-time ID check done before you can start. Your account and data are then deleted after 30 days. If you are an influencer and some earnings are still in the 7-day hold, closing waits for the release date; we show it on the Close page and message you on WhatsApp.' },
      { q: 'Can I pause instead of closing my account?', a: 'On the Close page, <b>Pause notifications</b> pauses only the Notify me WhatsApp messages. You can resume them any time. It does not close or change anything else.' },
      { q: 'Can I choose my name and handle?', a: 'Yes. Your profile shows the name you choose. Your @handle is permanent: pick it once, or if you never choose one we make one for you, and it cannot be changed later.' },
      { q: 'I was asked to accept updated terms. Why?', a: 'We updated our <a href="/terms">Terms</a>, <a href="/privacy">Privacy policy</a> and <a href="/community-guidelines">Community guidelines</a> to say that withdrawals go only to your own UPI ID (no bank accounts). You are asked to accept once; after that you carry on as usual.' },
    ],
  },
  {
    id: 'callers', title: 'For callers', hindi: 'Call karne waalon ke liye', icon: '✷', tone: 'lilac',
    items: [
      { q: 'How do I start a call?', a: 'Add money to your wallet (you need at least ₹20, or 5 minutes at their rate if that is more), pick an influencer who is online, check their price, and tap call. We call the influencer first. Once they accept, your phone rings and we join the two calls.' },
      { q: 'How do I find an influencer?', a: 'Filter by category and language. Each profile shows the topics that influencer has agreed to talk about and their per-minute price.' },
      { q: 'Can I end a call whenever I want?', a: 'Yes. Simply hang up. You can also press <b>#</b> at any time to end the call and block that person.' },
      { q: 'What do Online, Bookings only, Offline and On a call mean?', a: 'Each influencer picks a mode. <b>Online</b>: you can call now (or join the queue if they are busy) and book. <b>Bookings only</b> (shown as “Available by appointment”): no instant calls, but you can book an open time. <b>Offline</b>: no instant calls and no new bookings; bookings already confirmed still ring. <b>On a call</b> means they are talking to someone right now.' },
      { q: 'What if the influencer I want is offline?', a: 'Add them to your favourites and tap “Notify me”. We send you one WhatsApp when they come online. If they are on “Bookings only”, you can also book a time (see <a href="#callers">booking a call</a> below).' },
      { q: 'The influencer is on a call. Can I wait for them?', a: 'Yes. Tap <b>Join the queue</b> (or <b>Book a time</b> instead). We WhatsApp you “you’re in the queue #N” at once, and again when you are next. Nothing is charged while you wait, and you can leave the queue any time.' },
      { q: 'How does the call queue work?', a: 'When their call ends there is about a minute’s break, then we ring the influencer first and connect you automatically. At most 10 people can wait, and a wait is over after 2 hours. If you miss our call, you are removed from the queue. The influencer can pause the queue, and if they go Bookings only or Offline the queue closes and nothing is charged. To join you need at least ₹20, or 5 minutes at their rate if that is more.' },
      { q: 'How do I book a call, and for how long?', a: 'Open the influencer’s profile, pick a date, a time and a length: 15 minutes, 30 minutes, 1 hour, 2, 3, 4 or 5 hours. Booking holds the cost of the first 15 minutes in your wallet (or the whole call if it is 15 minutes). The rest is charged 5 minutes at a time while you talk, and anything unused comes back to your wallet.' },
      { q: 'What does “Waiting for approval” mean on a booking?', a: 'Some influencers approve each booking. Your request shows <b>Waiting for approval</b> and your money stays held. If they decline, or do not accept within 24 hours (or 1 hour before the call, whichever is earlier), you get the full amount back in your wallet. You can also withdraw a pending request any time for a full refund.' },
      { q: 'Can I cancel a booking?', a: 'Yes, free until 1 hour before the booked time, and the whole hold comes back to your wallet. If the influencer cancels, it always comes back in full.' },
      { q: 'How do I report or block someone?', a: 'Use <a href="/report">Report a person</a>. Your report is saved with a reference number you can quote, and our team reviews it. Blocking someone (with <b>#</b> on a call or from your dashboard) stops calls between you and removes them from <b>My Fraands</b>.' },
      { q: 'Can I share an influencer\'s page with a friend?', a: 'Yes. Every influencer\'s public page has a Share button. Tap it to copy the link or send it on WhatsApp, X or Facebook.' },
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
      { q: 'How do I find LGBTQ+ friendly influencers?', a: 'Influencers can choose to show <b>LGBTQ+ friendly</b> on their profile. There are also <b>LGBTQ+ channels</b>, started and called only by verified LGBTQ+ members (video KYC). Your declaration is private and never shown. Read more on <a href="/lgbtq">LGBTQ+ safety</a>.' },
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
      { q: 'What is a Women-only channel?', a: 'A channel started by a verified woman, for verified women. It shows a <b>Women-only channel</b> tag. Only women who complete video KYC (WhatsApp, Aadhaar and a selfie video) can call it. Every influencer can decline any call and press <b>#</b> to end and block. Read more on <a href="/women-only">women&rsquo;s safety</a>.' },
      { q: 'Does verification check that the caller is a woman?', a: 'For a Women-only channel, yes: the caller\'s Aadhaar must show female. For any other creator, video KYC confirms who the customer is, not their gender, and it does not guarantee behaviour. All the usual safety rules still apply.' },
      { q: 'What is a video-KYC verified customer?', a: 'A customer who did WhatsApp, Aadhaar and a short selfie video, once. Any creator can choose to take calls only from them, for free. They show a green <b>Video KYC verified</b> badge, and you can filter for them on Explore. We never share any customer&rsquo;s details with anyone.' },
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
      { q: 'Who can become an influencer on the platform?', a: 'Any adult in India with their own mobile number. You can go live by connecting a channel (20 or more followers, and 1,000 or more views on YouTube) or by doing a video KYC (Aadhaar and a short selfie video). You do not need a channel: individuals are welcome to chat, keep company and share their day. Sexual or adult talk is never allowed. For now, we only take on Indian creators. Create a free account, then upgrade to influencer for free from your dashboard. A Women-only or LGBTQ+ channel needs video KYC. Start at <a href="/hosts/join">Join &amp; earn</a>.' },
      { q: 'How much can I earn?', a: 'You set your own per-minute rate, as you see fit. Fans are charged for every connected minute of the phone call. We keep ₹2 a minute plus 40% of the rate above ₹2, and you keep the rest. At ₹20 a minute you earn ₹10.80 a minute. Being online does not guarantee calls. See <a href="/hosts/rates">rates</a>.' },
      { q: 'How do I withdraw my earnings?', a: 'Your earnings are credited after each completed call and held for 7 days. After that, tap <b>Withdraw</b> on your Earnings page (or in the app) and we send the money to your own UPI ID. We do not pay into bank accounts. We do a one-time ID (KYC) check and a UPI check before your first withdrawal. You can withdraw any amount in whole rupees with no fee, up to 2 requests a week. Each request shows waiting, approved, paid (with the bank reference, UTR) or not paid.' },
      { q: 'Can I choose when I take calls?', a: 'Yes, with the three-way switch. <b>Online</b>: instant calls, the queue and bookings. <b>Bookings only</b> (fans see “Available by appointment”): no instant calls or queue, but fans can book open times. <b>Offline</b>: no instant calls and no new bookings, but bookings already confirmed still ring, and the switch tells you how many. While you are talking fans see “On a call”. You can decline any call before it connects.' },
      { q: 'What is the call queue for influencers?', a: 'When you are on a call, fans can join a queue. When your call ends you get about a minute’s break and then we ring you first and connect the next fan automatically. You see how many are waiting and can pause the queue. If you miss a queued call twice in a row the queue pauses. Going Bookings only or Offline closes it.' },
      { q: 'Do I have to approve bookings?', a: 'You choose Manual (the default) or Auto-accept. With Manual, a booking is a request until you accept, and the fan’s money stays held. If you decline, or do not accept within 24 hours (or 1 hour before the call), the fan is refunded in full. Fans can book 15 minutes up to 5 hours, and the booking holds the first 15 minutes.' },
      { q: 'How do I share my page with my fans?', a: 'Once you are live, use the <b>Share my page</b> card on your dashboard Overview and Profile (and in the app: the Share my page card on Me, the row in Settings, or the share button on your profile). Copy the link, send it on WhatsApp, X or Facebook, put it in your Instagram bio, or show the QR code. See <a href="/help/hosts/share-your-page">share your page</a>.' },
      { q: 'What can I see about my fans?', a: 'You see your hearts and how many fans tapped Notify me for you. You never see a fan’s phone number or personal details.' },
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
      { q: 'How do I pay for calls?', a: 'You add money to a prepaid talk-time wallet on the wallet page. You can add any whole-rupee amount from ₹10 to ₹5,000. 18% GST is deducted from what you pay (you pay, minus GST, is what your wallet gets), so your wallet gets the amount divided by 1.18: pay ₹120, ₹18.31 GST is deducted and ₹101.69 is added. Each call is charged from that wallet at the per-minute rate set by the influencer, which you see before you call.' },
      { q: 'When does charging start?', a: 'A call is made once we have rung both of you and joined the call. You pay per minute spoken. Money is set aside 5 minutes at a time while you talk, and whatever you do not use goes straight back to your wallet. If the influencer declines, cancels or does not answer, you pay nothing.' },
      { q: 'How are minutes counted?', a: 'By the minute, at the influencer\'s rate. You need at least ₹20 in your wallet to start a call. If 5 minutes at their rate costs more than ₹20, you need that amount instead. A call can last up to 5 hours.' },
      { q: 'What happens when my wallet runs low?', a: 'If your wallet cannot cover the next 5 minutes, only you hear a short voice message that the call will end soon and asking you to top up. The influencer is never told it is about money. <b>Top up while you are talking</b> and the call keeps going. If you do not, it ends when the funded time is over. You can never go into debt.' },
      { q: 'What if a call breaks in the first minute?', a: 'If a joined call breaks within the first minute, we charge ₹1 and return the rest to your wallet.' },
      { q: 'Do you give refunds?', a: 'We do not refund calls that were made, except the first-minute rule above. You choose the influencer, see the price before calling and can hang up at any second, so you only pay for the minutes you spoke. See the <a href="/refunds">refund policy</a>.' },
      { q: 'I didn’t like my call with an influencer. Can I get my money back?', a: `No. ${B} connects you with an independent influencer; we are not responsible for how a particular conversation went, so we cannot refund a call because the experience was not what you hoped. Leave a rating, try someone else, and report the influencer if they broke a rule.` },
      { q: 'What happens if I book a call and cancel?', a: 'A booked call holds the cost of the first 15 minutes (or the whole call if it is 15 minutes) in your wallet. You can cancel free until 1 hour before, and the hold comes back to your wallet. After that the hold is kept. If the influencer does not pick up at the booked time, the full hold comes back. If the influencer cancels, or declines your request, it always comes back in full.' },
      { q: 'Where do refunds go?', a: 'All refunds go back to your wallet, never to your card or UPI.' },
      { q: 'Can I take my wallet money out?', a: 'Yes. Anyone can withdraw wallet money. On the website go to Wallet and use <b>Withdraw to UPI</b>, or tap Withdraw in the app. Money goes only to your own UPI ID (never a bank account), after a one-time ID (KYC) check. Enter any amount in whole rupees; we take no fee, and you can make up to 2 withdrawals a week. Test credits can be spent but not withdrawn.' },
      { q: 'How do I follow my withdrawal?', a: 'Each request shows its status: waiting, approved, paid or not paid. When it is paid you see the bank reference (UTR) of the transfer. You can cancel a request while it is still waiting, and the money returns to your wallet. If a request is not paid, the money also comes back.' },
      { q: 'What happens to my wallet if my account is banned?', a: 'A banned account can no longer make calls, but you can still sign in and withdraw wallet money with the Withdraw button. Wallet money is never taken away as a penalty.' },
      { q: 'What if I was charged twice, or for a call that was never made?', a: 'That is a billing error, not a refund request. <a href="/report">Report it</a> with the call ID and time. It will be checked against the call details, and the wrong amount is put back in your wallet, linked to that call.' },
      { q: 'Do I get a receipt?', a: 'Yes. Every top-up has a receipt in Wallet (tap View) showing what you paid, the GST deducted and what your wallet got. It also comes on WhatsApp and email. Every call charge appears in your wallet history with the date, duration and amount.' },
    ],
  },
  {
    id: 'partners', title: 'For payment & compliance partners', hindi: 'Gateway aur partners ke liye', icon: '◆', tone: 'peach',
    items: [
      { q: 'What does the business sell?', a: 'Paid phone calls between adult influencers and adult fans in India, charged per minute at the influencer\'s rate. Customers add money to a rupee wallet and spend it on call minutes. Every creator can choose, for free, to take calls only from video-KYC customers. We never share any customer\'s details with anyone. There are no physical goods, digital downloads or adult content.' },
      { q: 'Who are the service providers on the platform?', a: 'Influencers: independent adult individuals based in India. Earnings are withdrawn only to a UPI ID in the influencer’s own name; no bank accounts are used.' },
      { q: 'How do you prevent adult or prohibited content?', a: 'Sexual content is banned by our rules, influencer agreement and community guidelines. Reports are reviewed by our team, and violators receive strikes and bans. Limited, consented medical and intimate-health discussion is allowed only with influencers who opt in to that topic on their profile.' },
      { q: 'How do you prevent fraud on the platform?', a: 'Masked numbers, OTP and bank-detail scam warnings, press-<b>#</b> blocking, bans after team review, regular influencer training on scam awareness, and a rule that no money moves outside the platform.' },
      { q: 'Does anyone monitor or store call content?', a: 'No human monitors live calls. We keep call details (participants as account IDs, time, duration, charge) for billing and dispute handling.' },
      { q: 'How are minors kept off the platform?', a: 'Accounts are 18+ only, and accounts that appear to belong to a minor are suspended.' },
      { q: 'What is the refund and dispute policy?', a: 'Calls that were made are not refunded, except when a joined call breaks in the first minute (we charge ₹1 and return the rest). Customers pay only for the minutes they spoke, after seeing the price. If the influencer declines, cancels or does not answer, nothing is charged. All refunds go to the customer\'s wallet, never to a card or UPI, and wallet money can be withdrawn to the customer’s own UPI ID after a one-time ID check. A booked call is free to cancel until 1 hour before. Billing errors are corrected against call details.' },
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


// [HF-FAQ-REFRESH-1] / [HF-HELP-MERCH-1] MERCH topic: RENDERED since merch went live on 2026-10-23 (inserted into faqSections below). Originally drafted as NOT RENDERED. `merchFaqSection` is intentionally unused by /faq, the FAQPage
// structured data and faqCount, because influencer merch (HF-MERCH-1..12) is still switched off (hfMerchEnabled /
// hfMerchCheckoutEnabled). When merch goes live, add it to `faqSections` (e.g. insert before 'payments') in the same commit that
// publishes the merch help articles (draft: false). faq.astro's dabbaFor()/dabbaArt() may need an entry for the 'merch' id.
// Amounts that come from settings (60% / 40%, 7 days, minimum markup) are written as "currently".
export const merchFaqSection: FaqSection = {
  id: 'merch', title: 'T-shirts & merch', hindi: 'Apne influencer ki T-shirt', icon: '✿', tone: 'peach',
  items: [
    { q: 'Can influencers sell T-shirts?', a: 'Yes. An influencer uploads their own art, picks a T-shirt, places the art, adds a small markup and publishes it on their page. We print each T-shirt when you order and deliver it to you in India. One item per order for now.' },
    { q: 'How do I buy one?', a: 'Open an influencer\'s page, pick a T-shirt, a colour and your size, add your address, tick the Terms and the refund policy, and pay. See <a href="/help/wallet-and-payments/buy-influencer-tshirts">how to buy a T-shirt</a>.' },
    { q: 'What do I pay, and is delivery free?', a: 'One all-in price for your size, labelled incl. GST & delivery: the base price (printing including GST, plus delivery) plus the influencer\'s markup. GST is 5% on clothing up to ₹2,500, and other items are at their own GST rate. Delivery anywhere in India is free, and nothing is added at checkout.' },
    { q: 'Do I get a GST invoice?', a: 'Yes. We sell every item, so we email you a GST invoice, and you can download it from My orders.' },
    { q: 'How can I pay for merch?', a: 'From your wallet, or with UPI, card or net banking. The wallet pays merch only from money you added. Free test credit cannot be used for merch.' },
    { q: 'How long does delivery take, and how do I track it?', a: 'Each T-shirt is checked by our team and then printed for you, so it takes some time. Your order moves from Placed to Approved, Printing, Shipped and Delivered. We send the courier and tracking link on WhatsApp and email, and you can follow it in My orders. See <a href="/help/wallet-and-payments/track-your-merch-order">track your order</a>.' },
    { q: 'Can I return a T-shirt?', a: 'No returns or exchanges, because each T-shirt is printed for you. If it is wrong or damaged, report it within 48 hours of delivery with a photo and we replace it or refund you. A refund goes back the way you paid. See <a href="/help/wallet-and-payments/merch-wrong-or-damaged-item">wrong or damaged T-shirt</a> and the <a href="/refunds">refund policy</a>.' },
    { q: 'Does the influencer see my address or phone number?', a: 'No. They see only your first name, your city and state and a blurred address line. Your phone, email, full address and payment details stay private.' },
    { q: 'I am an influencer. How do I sell T-shirts?', a: 'Open Merch in your dashboard or the app, upload your art and tick that you own it, pick a T-shirt, place the art (a quality meter blocks blurry prints), add your markup (at least ₹10) and send it for review. See <a href="/help/hosts/sell-t-shirts">how to sell T-shirts</a>.' },
    { q: 'How much do I earn from a T-shirt?', a: 'The base price is the printing (including GST) plus the delivery, shown size by size. The fan pays base plus your markup, as one price that includes GST and delivery. We sell every item and issue the fan the GST invoice. You earn a design royalty of 60% of your markup (currently), and the GST and payment fees never reduce it. Your merch money can be withdrawn 7 days after delivery (currently). A refunded order earns nothing. See <a href="/help/hosts/merch-orders-and-earnings">merch orders and earnings</a>.' },
    { q: 'My merch picture is too blurry to print. What can I do?', a: 'In the design studio, tap Make it sharper (free). We make a bigger, sharper copy of your picture (up to 10 a day). You can also make the picture smaller on the product, or use a bigger file. We make AI pictures extra large so they can fill a whole T-shirt front.' }, // [HF-MERCH-AI-HIRES-1]
    { q: 'What can influencers sell?', a: 'T-shirts, hoodies, mugs, bottles, phone cases, posters and more. Clothing is capped at ₹2,500 so the 5% GST rate applies; other items are at their own GST rate.' },
    { q: 'Do I need a GST number to sell T-shirts?', a: 'No. You can start without one. There is an optional GSTIN field if you have a number and want to add it.' },
    { q: 'Why is my product or order waiting?', a: 'Every new product is reviewed by our team before it goes on sale, and every paid order is checked before it is printed. If the printing cost has risen a lot since you set your price, an order may be cancelled with a full refund to the fan, and you are asked to raise your price.' },
  ],
};

// [HF-HELP-MERCH-1 2026-10-23] Merch is live (hfMerchEnabled on): show the topic on /faq and in the FAQPage data, before Payments.
{
  const at = faqSections.findIndex((x) => x.id === 'payments');
  faqSections.splice(at < 0 ? faqSections.length : at, 0, merchFaqSection);
}

export const faqCount = faqSections.reduce((n, s) => n + s.items.length, 0);
