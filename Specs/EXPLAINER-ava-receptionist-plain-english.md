# What we're building — in plain words
*(AvaDial: Ava answers the calls you don't, and protects everyone from spammers)*

## The problem
You get calls from numbers you don't know. Some matter (a delivery rider, a new client). Most don't (sales agents, scammers). Today you either pick up and waste your time, or ignore it and maybe miss something important. And caller-ID names in India only show a person's private name — "Monika" — never "Monika, the loan-sales agent."

## What will happen instead

**1. Your phone rings like normal.** You see the call and choose: answer it, or reject it. Nothing changes about calls from people in your contacts.

**2. If you reject the call — or simply don't pick up — Ava answers for you.**
The phone network quietly passes the call to a phone number we rent (from a company called Vobiz — think of it as our phone line in the cloud). Our AI receptionist, Ava, picks up and speaks to the caller:

> *"Hi, Davy isn't available right now — may I ask who's calling and what it's about?"*

She listens, asks one or two short follow-ups, then says *"I'll let Davy know. Thanks for calling"* and hangs up. The whole thing takes under a minute (hard limit: 3 minutes, so it can never run up a big bill). Callers who hide their number don't even ring your phone — they go straight to Ava.

**3. You get the message in a new Inbox inside AvaDial.**
The Inbox looks like a chat app. You see "Missed call from +91 98xxx / Monika." Tap it, and inside the thread is the audio recording of what the caller told Ava, with the written transcript right underneath it. A back button takes you to the list. If the same number calls again next month, that message lands in the same thread — one conversation per caller, forever.

**4. Behind the scenes, Ava Guardian learns who the bad callers are.**
Every conversation Ava has gets read (by machine, not people) for signals: does this sound like a sales pitch? A loan scam? A delivery? Those signals are attached to the caller's number — never to what they said to you specifically; your recordings stay yours alone. When the same number gives off the same "salesman" or "scammer" signals to other AvaTOK users too, its score climbs. Past a threshold, the number is marked a spammer for **everyone on the network**: the next person it calls sees a red warning — or the call is blocked outright and they just get a note saying "Ava Guardian blocked a likely scammer." Users can also report a number themselves after a call (sales / scam / robocall / delivery), which feeds the same score.

The more people use it, the smarter it gets — like a neighbourhood watch for phone calls.

## What it costs to run
Three small costs per screened call: a few paise to the phone company for the forwarded call, a few paise of AI time (capped at 3 minutes), and the rent on the shared cloud numbers (~₹500/month each — one number can serve thousands of users because it's only busy during the seconds a call is being screened).

## What we are NOT doing
- Ava never answers calls from your contacts — they always ring through to you.
- Your recordings and transcripts are private to you. Only the number + the category signal ("sounds like sales") is shared with the network.
- No calls are ever made from your number. Nothing about your normal calling changes.

## The steps to get there (in order)
1. **Test the phone trick** — confirm on real Jio/Airtel/VI SIMs that a rejected call really does get passed to our cloud number. (This is the one thing that can kill the idea, so we test it first.)
2. **Teach our cloud to answer** — connect the Vobiz phone line to Ava's brain (which we already built for another feature) so she can hold the conversation and save the recording.
3. **Build the Inbox** in AvaDial — the chat-style list of missed-call threads.
4. **Turn on Ava Guardian** — the signal-reading and scoring system, plus the red warnings and auto-blocking.
5. **Try it with a few testers, then release.**
