# SPEC 2026-09-30 — Preeti lead gate (issue SAATHUM-PREETI-LEADGATE-1)

Supersedes SAATHUM-PREETI-SIGNIN-1 (sign-in wall) and the "identity card at the start" + "Talk to a human" button of SAATHUM-PREETI-1.
Base contract: Specs/SPEC-2026-09-30-PREETI-AI-AGENT.md + worker/src/lib/preeti/contracts.ts. Same hard repo rules (no brand literals, no silent catch, no npm install, no deploy/commit, worktree only).

## Owner decisions (verbatim intent, 2026-09-30)
1. Anyone (not signed in) can open Preeti. She greets first (welcome_text). The visitor types their question.
2. For a NOT signed-in visitor whose conversation has no email+WhatsApp yet: Preeti does NOT answer yet. She replies (fixed text, NO Gemini call — this is the anti-bot / cost guard):
   "Before we go further, could you share your email and WhatsApp number? I need these to forward our chat to you. I promise I won't spam you 🙏 And next time you come, I'll be able to remember you."
   Written in Hinglish when the visitor wrote in Hindi/Hinglish (simple heuristic: Devanagari chars or common Hinglish words -> Hinglish variant:
   "Aage badhne se pehle, kya aap apna email aur WhatsApp number share karenge? Main hamari baatcheet aapko forward kar dungi. Promise, koi spam nahi 🙏 Aur agli baar aap aayenge to main aapko yaad rakhungi.")
   The widget then shows an inline form: Email + WhatsApp number (country code, default +91). No "Skip".
3. After the visitor submits valid details, Preeti immediately answers the question(s) they already asked (no retyping).
4. Signed-in users (Clerk) are never asked; their email + verified WhatsApp come from the profile.
5. Remove the always-visible "Talk to a human" button and any automatic WhatsApp/handover link. The support WhatsApp number/link appears ONLY when the visitor clearly wants a human (asks for a person/agent/human/call/insists) — i.e. only via the handover_to_human tool. No handover link on angry mood alone, on errors, or for anything else.
   Errors show a plain retry line. Over-budget shows a fixed "I'm taking a short break, please try again a little later 🙏" (Hinglish variant ok) with no number.
6. "Forward our chat to you": send the visitor a transcript EMAIL (not WhatsApp) once a conversation has been idle 30 minutes and has new messages since the last transcript. From the site's default sender, subject "Your chat with {agent} — {brand}", plain readable HTML (visitor/Preeti turns, event links as links), footer one line. Only to the email the visitor gave (or the signed-in user's email). Never for is_test conversations.
7. "Remember you": anonymous memory is per browser (visitor_id). Returning visitor with details on file is greeted by name if known and never asked again. Phone/email typed on another device must NOT unlock earlier history (unverified) — do not implement cross-device merge by phone/email.

## Backend changes (Agent A2 owns worker/**)
- Migration worker/migrations/2026-09-30-preeti-leadgate.sql (ALTER-only file): ai_conversations ADD COLUMN email TEXT; ADD COLUMN transcript_sent_through_id INTEGER; ADD COLUMN transcript_sent_at INTEGER.
- routes/preeti.ts: REVERT the sign-in wall (session + chat work for anonymous again, rate limits kept). Session for anonymous: do NOT create a conversation row until the first message (avoid empty inbox rows): return conversation_id "" when none exists yet; chat creates it on first message if conversation_id is "" (return its id in the SSE `session` event, see below). Keep ownership checks.
  needs_identity = anonymous && !(email && e164). Remove needs_signin usage (keep the optional field in the type, always false/absent).
- POST /api/preeti/identify {conversation_id, visitor_id, email, whatsapp, name?}: validate email (simple RFC-ish regex, ≤254) and normalizeE164; save; return {ok, e164, email}. 400 with {error:'invalid_email'|'invalid_phone', message, field}.
- POST /api/preeti/chat: body may carry `answer_pending: true` with empty message → answer the latest unanswered visitor message(s) (concatenate those after the last preeti reply) without inserting a new visitor row. Gate: if anonymous and !(email && e164) → store the visitor message, reply with the fixed ask text (delta events, stored as a preeti message, no Gemini, no cost), then emit `{type:'identity_required'}` and `done`.
- New stream events in contracts.ts PreetiStreamEvent (and mirror in web/src/lib/preetiTypes.ts — Agent A2 edits contracts.ts, Agent B2 mirrors): `{ type: "identity_required" }` and `{ type: "session"; conversation_id: string }` (sent first when the server created the conversation).
- Handover: remove the "angry mood → handover event" branch in chat.ts; error/over-budget paths send no handover. Core rules (core_rules.ts): hand over ONLY when the customer asks for a human/person/agent/call or insists after you offered help; never offer the WhatsApp number otherwise; never mention the number in text except inside the handover. Keep calm-with-angry-customers rules.
- Transcript email: export runPreetiTranscriptEmails(env) (lib/preeti/transcripts.ts), called every cron tick from scheduled() in index.ts beside the other Preeti call (try/catch → trackException). Picks ≤20 conversations with email NOT NULL, is_test=0, last_message_at < now-30min, and max(message id) > COALESCE(transcript_sent_through_id,0). Uses the existing email outbox helper (lib/email_outbox.ts enqueueEmail — read how admin2_weather_notice.ts uses it; idempotency key per conversation + through_id). Brand via currentBrand; scrubFormerNames on text.
- Admin: AdminAiConversationRow gains `email: string | null` (contracts.ts + admin2_ai.ts list/detail + search by email).
- Telemetry: preeti_identity_asked, preeti_identified (source 'form'|'profile'), preeti_transcript_emailed; update ship_manifest entry SAATHUM-PREETI-LEADGATE-1 (copy the shape of SAATHUM-PREETI-1).

## Widget + admin (Agent B2 owns web/**)
- Remove the sign-in card and SIGNIN_TEXT and needs_signin handling; remove the header "Talk to a human" button; remove the start-of-chat IdentityCard.
- On open: show welcome_text (+ language chips + quick replies as before). No network session write needed beyond POST /session.
- Handle `session` event (store conversation id in state + localStorage) and `identity_required` (show the inline form under Preeti's ask: Email, WhatsApp (+91 default), submit button "Share & continue"; input disabled while the form is showing). On success → call chat with {answer_pending:true, message:""} and stream the answer. Show server field errors.
- Handover event stays: render a WhatsApp button bubble ONLY when a `handover` event arrives. Errors: plain "Kuch gadbad ho gayi, kripya dobara try karein 🙏" (no WhatsApp). Over budget from config: show the break message, no number.
- Admin Conversations: show email under the phone in the list row and chat header; search placeholder mentions email.
