# SPEC 2026-10-01 — Voice guides (Gemini Live) — wave 2 build contract

Owner plan: project doc `claude/voice-agents-plan.md`. Mockup: "Aum Fe Voice Agent Call" design canvas (phone + iPad).
Code contract: `worker/src/lib/voice_agents/types.ts` (agent/tool interfaces + wire protocol). Do not drift from it.

## Already on main (wave 1)
- `worker/src/lib/astrology/` — `astroCall`, `geoLookup`, `mcpListTools`, `mcpCallTool`, `toGeminiFunctionDeclarations`, endpoint registry.
- `worker/src/lib/agent_memory/` — `getProfile`, `upsertProfile`, `setConsent`, `remember`, `recall`, `listMemories`,
  `forgetOne`, `forgetAll`, `startSession`, `endSession`, `buildBriefing`. Routes under `/api/me/astro-profile`, `/api/me/memories`, ...
- D1 tables applied in prod: `astro_api_cache`, `astro_profiles`, `ai_memory`, `agent_sessions`.

## Lanes (one worktree each)
| Issue | Owns |
|---|---|
| AUMFE-VOICE-RUNTIME-1 | `worker/src/do/voice_session.ts`, `worker/src/routes/voice.ts`, `worker/src/lib/voice_agents/registry.ts`, `worker/src/lib/voice_agents/memory_tools.ts`, wrangler DO binding + migration block (append), config keys in `routes/config.ts` (append), one route-registration line in `index.ts` |
| AUMFE-ASTRO-AGENT-1 | `worker/src/lib/voice_agents/agents/astrology.ts` (+ tests) ONLY |
| AUMFE-VOICE-WEB-1 | `web/src/pages/talk/**`, `web/src/islands/voice/**`, `web/public/voice/**` (AudioWorklet), nothing else |

`registry.ts` (runtime lane) imports `agents/astrology.ts` by its default export `astrologyAgent: VoiceAgentDef`.

## Decisions
- Model: Gemini Live on the Developer API (`generativelanguage.googleapis.com`, BidiGenerateContent), NOT Vertex
  (see `worker/src/lib/vertex.ts` header). Model id comes from remote config `voiceAgentModel`
  (default `gemini-3.8-live`). Reuse patterns from `worker/src/do/reception_room.ts` and `worker/src/routes/ava_live.ts`.
- Gate: remote config `voiceAgentsEnabled` (default false). When false, only uids in the existing `AGENT_ADMIN_UIDS`
  env var may open a session (owner testing). No new text bindings (the worker is at the 128 text-binding limit).
- Billing in wave 2 = `"test"`: meter and report cost, never charge. `voiceAgentMaxSeconds` (default 900),
  `voiceAgentFreeSeconds` (180), `voiceAgentPricePerMinPaise` (2000).
- Memory: at session start `buildBriefing(env, uid, agentId)` goes into the system prompt and `ready.remembers`
  shows up to 3 short lines. On close: `endSession(env, uid, sessionId, transcript, {minutes, ctx})`.
  `startSession(..., "voice")` on connect. Transcript = input + output transcriptions, "Customer:" / "<Name>:" lines.
- Tools: the model never supplies whose chart — tools read the caller's saved `astro_profiles` row.
- Disclosure: every agent says she is an AI guide if asked, and the UI labels her "AI guide".
- Telemetry (PostHog via `track`): `voice_session_started`, `voice_session_ended {seconds, reason, tool_calls, ok}`,
  `voice_tool_call {tool, ms, ok}`, `voice_first_audio_ms` (time from start to first agent audio), `$ai_generation` per session.
