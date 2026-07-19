# PLAN — Gemini 3.1 Live Receptionist: India Fine-Tune (2026-07-19)

Synthesized from live-call telemetry (PostHog, per-utterance `ava_recept_dialog`) + a
4-turn consult with ChatGPT (chatgpt.com/c/6a5c3a40, 2026-07-19). Owner-reported
issues this plan targets: (1) too chatty, (2) double goodbye after caller sign-off,
(3) tone swings flat↔over-energetic. Market: India (Hindi/Hinglish code-switching).

Consensus diagnosis: **remaining issues are ORCHESTRATION problems, not LLM
problems** — ~70% engineering on the relay state machine, ~30% on prompt.

## Implementation order (impact-per-effort, agreed by both analyses)

### 1. Terminal CLOSING state + idle-nudge suppression  ★★★★★ / low effort
Root cause of the double goodbye: after Ava's farewell the relay's idle-nudge
(anti-dead-air poke in `do/reception_room.ts`) wakes the model, which farewells
again. Fix in the Gemini DO:
- Detect Ava farewell (en + hi phrase list: goodbye/bye/take care/धन्यवाद/नमस्ते/
  अलविदा/…) in her transcript → `state = CLOSING`.
- In CLOSING: **disable idle nudges entirely**, ignore silence, react only to
  (a) caller speech (→ back to HELPING), (b) end_call, (c) timeout.
- Idle watchdog may only operate in the active/WAITING state — never CLOSING.

### 2. Goodbye → end_call server grace of 1–2s  ★★★★★ / very low effort
Today the line sits open 5–10s after her goodbye (the window the second goodbye
happens in). After her farewell + 1.5s of caller silence → server invokes
end_call itself. Silence after a goodbye is SUCCESS, not a problem to fix.

### 3. Compact 8-rule prompt rewrite  ★★★★☆ / low effort
Target 200–500 tokens. Keep ONLY (verbatim skeleton):
1. Role: "You are Ava, answering calls on behalf of {owner}." (+ caller context:
   name, why owner can't pick up, owner has caller's number)
2. Brevity: "Default to 1–2 short sentences. Expand only if the caller asks."
3. Language mirroring: "Mirror the caller's language and Hindi/English MIX
   naturally — don't flip to pure Hindi/English unless they do; keep common
   English words (payment, meeting, OTP, WhatsApp…) in English."
4. Respect: "Polite Indian phone etiquette. Default 'aap', never 'tum' first.
   Mirror ji/sir/ma'am lightly (max one per sentence)."
5. Rhythm: "Answer, ask at most one question, then stop. Silence is acceptable."
6. Numbers: "Repeat phone numbers back ONCE for confirmation, in the caller's own
   digit grouping (Indian pairs: 98 76 54 32 10)."
7. Goodbye: "Say goodbye once; mirror the caller's farewell style (Bye→Bye,
   धन्यवाद→धन्यवाद, नमस्ते). Never reopen after a farewell unless the caller
   speaks first."
8. Tool: "When the conversation is clearly finished, call end_call."
Plus the behavioral voice block (NOT adjectives): calm and composed / natural
Indian conversational pacing / moderate energy / slight smile in greeting only,
neutral thereafter / never excited, never robotic.
CUT everything else (30-rule list) — Gemini infers etiquette details.

### 4. One-line wrap cue  ★★★☆☆ / trivial
Mid-session [SYSTEM] injections are the HIGHEST-impact text (they become the
freshest instruction and shift tone). Replace the wrap paragraph with exactly:
`[SYSTEM] Begin wrapping up naturally. Finish within ~30 seconds. Do not mention time.`

### 5. Metrics (prove/disprove each fix)  ★★★☆☆ / low effort
From `ava_recept_dialog` (already shipping) derive per call:
- Chattiness: avg + median + p95 **Ava words/turn**; talk ratio (Ava words ÷
  caller words); consecutive-Ava-turns count (should be ~0).
- Double goodbye: farewell_count (target ==1); speech_after_first_goodbye
  (target 0); first_goodbye→end_call latency (target 1–2s).
- Tone proxies: question rate per Ava turn; avg sentence length.
- Language: caller vs Ava language per utterance (hi/en/mixed) → mismatch rate.
- NEW EVENT: per-turn response latency (caller end-of-speech → Ava first audio),
  P50/P95 — the single best perceived-quality metric.
- Barge-in: continued_talking_after_bargein → should trend to 0.

## Session-level config (Live API)
- **Endpointing/VAD**: slightly aggressive end-of-turn (don't wait 1–2s of
  silence; don't fire on "uh…"). Biggest non-prompt lever.
- **Barge-in**: ensure interruption is enabled; she must stop mid-sentence.
- **Temperature 0.2–0.4** for consistency of tone/length (avoid 0 = rigid).
- **Voice**: most neutral Indian-compatible female voice; avoid "assistant demo"
  cheerfulness (voice choice affects perceived warmth more than prompt words).
- **Proactive speaking OFF** — server decides wrap/nudge/end, never the model.

## Facts to respect (already established in this repo)
- Prompt lives in `composeReceptionistPrompt` (worker/src/routes/receptionist.ts,
  [AVA-UNSCRIPTED-1] already removed the step-script; this plan compresses it).
- Caps now config-driven: receptWrapCueMs=120000 / receptCloseMs=160000 /
  receptHardCapMs=180000 ([AVA-CONVO-BUDGET-1]).
- Idle nudge + wrap cue + end_call live in `worker/src/do/reception_room.ts`
  (`ava_recept_idle_nudge`, `onWrapCue`, end_call tool).
- Per-utterance telemetry: `ava_recept_dialog` {who, seq, at_ms, text≤220}
  ([AVA-CONVO-TELEMETRY-1]).
- P12: Ava is female, always. Names phonetic in Indic scripts ([AVA-TTS-NAMES-1]).
