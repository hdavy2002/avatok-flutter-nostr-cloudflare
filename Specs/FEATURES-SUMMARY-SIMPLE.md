# What we built — a simple summary

*Plain English. Each item: what it does, and how it helps.*

## Safety

**AI content check on what people type**
Before a name, bio, listing, or AI-receptionist instruction can be saved, an AI checks it and
blocks anything abusive or inappropriate. *Helps: keeps the app clean and protects your brand;
stops people abusing free-text fields.*

**Chat "shield" watchdog (grooming & scam protection)**
Turn on the shield in a chat and an AI reads incoming messages for predators, grooming, and
scams. If it spots something, it sends a **private** warning only the at-risk person sees, marks
the dangerous message in **red**, and if the sender keeps it up it **blocks them** and alerts a
parent. *Helps: real child-safety; parents can trust us; it's free on all plans.*

**Stronger detection for safety, lighter model for the rest**
The shield uses a powerful AI (Claude Opus) because spotting grooming needs nuance; the everyday
field checks use a cheaper one. *Helps: best protection where it matters, lower cost elsewhere.*

## Messaging

**Soft delete with Undo**
Deleting a message now hides it (with an **Undo**) instead of destroying it, so you can recover
something you deleted by mistake, copy it, and hide it again. *Helps: no more "oops, gone
forever"; people feel safe deleting.*

**Delete for everyone (done properly)**
"Delete for everyone" now actually removes the message from the other person's phone and from our
server — while you keep a private, recoverable copy. *Helps: it finally works as expected, and
respects the other person's view.*

**Your deletes follow you across devices**
Hide or undo on your phone and your Mac/PC reflect it too. *Helps: consistent experience on every
device.*

## Search & Contacts

**Search across all your chats**
A new search finds messages across every conversation, not just the one you have open — instant
from your phone, then topped up from online so nothing is missed across devices. *Helps: people
find old messages fast; works offline; free for everyone.*

**Find people by their bio, too**
People search now also matches what someone wrote about themselves, so "find that designer" works
even if "designer" isn't in their name. *Helps: easier to find and add the right person on the
network.*

**"Invite friends" is now "Contacts"**
The menu is renamed to Contacts — the home for seeing and managing everyone (invite still inside).
*Helps: clearer place to manage people; sets up the upcoming status dots.*

## Behind the scenes

**Everything is being measured (PostHog)**
Every feature now reports what's happening — including which **country** activity comes from and
who is affected — so we can catch errors fast and see what people actually use. *Helps: we fix
problems quickly and make decisions from real data.*

**One dashboard for a bird's-eye view**
A single PostHog dashboard, **"AvaTOK — Safety, Delete & Search,"** shows the shield activity,
moderation, deletes/undos, search usage, and flagged-by-country at a glance.
*Helps: one screen to watch the health and usage of all of this.*

---

## Still to come (planned, not built yet)

- **Online second half of search + the "one cabinet, private drawers" search model** — so each
  person's searchable data is isolated and an account can be deleted in a single move.
- **Status dots in Contacts** — green (online), yellow (away, "active 3h ago"), red (phone off),
  grey (not on AvaTOK), using the realtime rail Cloudflare already gives us (no extra vendor).
- **Storage tidy-up** — moving old messages out of expensive storage and a 30-day delete-then-wipe.
  *(Some of this shares a file another developer is mid-edit on, so we'll take it cleanly after.)*

> Status: built and committed locally across several commits; **not pushed yet** (waiting for your
> go). The server safety pieces that were deployed are live; the app-side pieces ship with the next
> app build.
