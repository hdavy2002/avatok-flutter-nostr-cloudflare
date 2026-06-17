# Phase 7 — Delegate: Monitor + Auto-reply + Push

**Read `00-MASTER-PLAN.md` first. 🚫 No commit/push — leave the tree for Phase 11.**

## Depends on
P0, P2 (gate/classifier), P3 (posts via spine). Uses existing `notifications.ts`/push.

## OWNED FILES
- NEW: `worker/src/routes/ava_delegate.ts` — monitor a thread (classifier gate),
  detect `@mention` of the user, generate a disclosed auto-reply, fire push.
- NEW dir `app/lib/features/ava_delegate/` — per-chat settings ("monitor & reply on
  my behalf", "alert me on all mentions") + the disclosed-reply UI affordance.
- NEW: `app/lib/features/settings/sections/delegate_section.dart` (registered).

## DO NOT TOUCH
P0 hot files, `notifications.ts` (call it; if it must change, note for Phase 11),
spine files (P3 — use its posting API).

## Tasks
1. Opt-in per chat. **Classifier gate first** (cheap) — only escalate to the model on
   a real mention/trigger, never run the reasoner on every message.
2. Auto-reply is **always disclosed** as "Ava — for <name>" (never impersonate).
3. Push alert on mentions via the existing push path.
4. Persistent "Ava is active in this chat" indicator for all participants.

## Acceptance
- `@user` in a monitored group triggers a disclosed Ava reply + a push to the user.
- Non-monitored chats incur zero model cost.
- Only OWNED FILES changed. No git ops. Note appended to INTEGRATION-NOTES.md.
